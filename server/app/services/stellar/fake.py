"""In-memory fakes for tests (DESIGN §2.6). No network.

``FakeSorobanGateway`` replicates the vault contract's state machine (``contracts/vault/src/lib.rs``):
agreements, per-agreement token balances, the token allow-list, a price table standing in for the
Soroswap router, drawdown checks and the §1.4 settlement math (via ``app.services.amounts.settle_math``).
Builders return an ``UnsignedTx`` whose XDR is a real, syntactically valid unsigned envelope (built with
stellar_sdk, source = the user, one ``invoke_contract`` op with the real function name and SCVal args)
and dry-run the action so contract rule violations surface at build time exactly like a real simulation
would. ``send()`` applies the action recorded for that transaction hash (signing does not change the
hash), records a ``TxResult`` and emits the same events the contract would (encoded with
``contract_abi`` so the indexer decodes them with the production code path).

``FakeHorizonGateway`` keeps classic accounts, trustlines, balances and payment history and applies
payment / change_trust / create_account envelopes handed to ``submit_xdr``.
"""
from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from fractions import Fraction
from typing import Any

from stellar_sdk import Account, Keypair, TransactionBuilder, TransactionEnvelope
from stellar_sdk import xdr as sx
from stellar_sdk.operation import ChangeTrust, CreateAccount, Payment
from stellar_sdk.strkey import StrKey

from app.core.config import SOROSWAP_ROUTER_TESTNET, TESTNET_PASSPHRASE
from app.core.errors import StellarError, ValidationError
from app.services import amounts as money
from app.services.stellar import contract_abi as abi
from app.services.stellar.contract_abi import (
    MAX_TOKENS,
    ActivatedEvent,
    Agreement,
    CancelledEvent,
    Config,
    ConfigChangedEvent,
    Fn,
    OpenedEvent,
    ProposedEvent,
    SettledEvent,
    Status,
    Terms,
    TokenInfo,
    TokenSetEvent,
    TradedEvent,
    VaultContractError,
    VaultError,
    VaultEvent,
)
from app.services.stellar.types import (
    AccountInfo,
    AccountNotFoundError,
    AccountSigners,
    AssetRef,
    Balance,
    EventRecord,
    PaymentRecord,
    RouterQuote,
    SimulationResult,
    SubmitResult,
    TxRejectedError,
    TxResult,
    UnsignedTx,
)
from app.services.stellar.xdr_utils import (
    amount_str,
    apply_memo,
    from_sdk_asset,
    memo_text_of,
    parse_payment_envelope,
    to_sdk_asset,
)

log = logging.getLogger(__name__)

# Soroswap testnet token ids (DESIGN §1.8 / §3.2) so fixtures line up with scripts/seed_assets.py.
TESTNET_XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
TESTNET_USDC = "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F"
TESTNET_EURC = "CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT"
TESTNET_CIRCLE_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

FAKE_VAULT_ID = StrKey.encode_contract(bytes([0xFA]) * 32)
FAKE_ADMIN = Keypair.from_raw_ed25519_seed(bytes([0xAD]) * 32).public_key
FAKE_ANCHOR_ACCOUNT = Keypair.from_raw_ed25519_seed(bytes([0xA1]) * 32).public_key
FAKE_FRIENDBOT = Keypair.from_raw_ed25519_seed(bytes([0xFB]) * 32).public_key
DEFAULT_NOW = 1_800_000_000  # 2027-01-15, a fixed fake ledger clock
TX_TIMEOUT = 180
BASE_FEE = 100


class FakeAuthError(StellarError):
    """Mirrors a host ``Error(Auth, InvalidAction)``: the tx source is not the address that must authorise."""

    status_code = 403
    code = "auth_error"


# --- vault state -----------------------------------------------------------------------------


@dataclass
class _VaultState:
    config: Config
    tokens: dict[str, TokenInfo] = field(default_factory=dict)
    agreements: dict[int, Agreement] = field(default_factory=dict)
    balances: dict[tuple[int, str], int] = field(default_factory=dict)  # (agreement id, token) -> raw
    wallets: dict[tuple[str, str], int] = field(default_factory=dict)  # (address, token) -> raw
    next_id: int = 1


@dataclass
class _Pending:
    kind: str
    fn: str
    source: str
    xdr: str
    apply: Any  # Callable[[_VaultState], tuple[Any, list[VaultEvent]]]
    summary: dict[str, Any]


class FakeSorobanGateway:
    """Drop-in for ``SorobanGateway`` (same coroutine names/signatures) backed by an in-memory vault."""

    def __init__(
        self,
        settings: Any | None = None,
        *,
        network_passphrase: str | None = None,
        vault_contract_id: str = FAKE_VAULT_ID,
        router_id: str = SOROSWAP_ROUTER_TESTNET,
        admin: str = FAKE_ADMIN,
        fee_recipient: str | None = None,
        platform_fee_bps: int = 0,
        settle_slippage_bps: int = 100,
        strict_wallets: bool = False,
        now: int = DEFAULT_NOW,
    ) -> None:
        self._settings = settings
        self.network_passphrase = network_passphrase or getattr(settings, "network_passphrase", None) or TESTNET_PASSPHRASE
        self.rpc_url = "fake://soroban"
        self.vault_contract_id = vault_contract_id
        self.router_id = router_id
        self.strict_wallets = strict_wallets
        self.now = int(now)
        self.ledger = 1000
        self.prices: dict[tuple[str, str], Fraction] = {}
        self.horizon: FakeHorizonGateway | None = None
        self._state = _VaultState(
            config=Config(
                admin=admin,
                router=router_id,
                platform_fee_bps=platform_fee_bps,
                fee_recipient=fee_recipient or admin,
                paused=False,
                settle_slippage_bps=settle_slippage_bps,
            )
        )
        self._sequences: dict[str, int] = {}
        self._pending: dict[str, _Pending] = {}
        self.results: dict[str, TxResult] = {}
        self.events: list[EventRecord] = []
        self.sent: list[str] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []  # (method, kwargs) audit trail for tests
        self.api_quotes: dict[tuple[str, str], int] = {}  # optional canned Soroswap API answers
        self.install_defaults()

    # --- setup helpers ----------------------------------------------------------------------

    def install_defaults(self) -> None:
        """Testnet-like allow-list and prices: XLM/USDC/EURC (Soroswap test tokens) + Circle USDC as base
        without liquidity (exactly the testnet situation in DESIGN §3.2)."""
        self.set_token(TESTNET_XLM, True, True)
        self.set_token(TESTNET_USDC, True, True)
        self.set_token(TESTNET_CIRCLE_USDC, True, True)
        self.set_token(TESTNET_EURC, True, False)
        self.set_price(TESTNET_XLM, TESTNET_USDC, "0.29")
        self.set_price(TESTNET_XLM, TESTNET_EURC, "0.25")
        self.set_price(TESTNET_USDC, TESTNET_EURC, "0.86")

    @property
    def vault(self) -> str:
        return self.vault_contract_id

    def reset(self) -> None:
        self.__init__(  # type: ignore[misc]
            self._settings,
            network_passphrase=self.network_passphrase,
            vault_contract_id=self.vault_contract_id,
            router_id=self.router_id,
            strict_wallets=self.strict_wallets,
        )

    def advance(self, seconds: int) -> None:
        """Move the fake ledger clock forward (agreement expiry, deadlines)."""
        self.now += int(seconds)
        self.ledger += max(1, int(seconds) // 5)

    def set_time(self, timestamp: int) -> None:
        self.now = int(timestamp)

    def set_token(self, token: str, allowed: bool, is_base: bool) -> None:
        self._state.tokens[token] = TokenInfo(allowed=bool(allowed), is_base=bool(allowed and is_base))

    def set_paused(self, paused: bool) -> None:
        self._state.config = replace(self._state.config, paused=bool(paused))

    def set_fees(self, platform_fee_bps: int, fee_recipient: str | None = None) -> None:
        cfg = self._state.config
        self._state.config = replace(cfg, platform_fee_bps=int(platform_fee_bps), fee_recipient=fee_recipient or cfg.fee_recipient)

    def set_settle_slippage(self, bps: int) -> None:
        self._state.config = replace(self._state.config, settle_slippage_bps=int(bps))

    def set_price(self, token_in: str, token_out: str, price: Decimal | str | Fraction, *, both_ways: bool = True) -> None:
        """``amount_out = amount_in × price`` (floor). With ``both_ways`` the inverse is installed too."""
        frac = price if isinstance(price, Fraction) else Fraction(Decimal(str(price)))
        if frac <= 0:
            raise ValueError("price must be positive")
        self.prices[(token_in, token_out)] = frac
        if both_ways:
            self.prices[(token_out, token_in)] = 1 / frac

    def remove_route(self, token_in: str, token_out: str, *, both_ways: bool = True) -> None:
        self.prices.pop((token_in, token_out), None)
        if both_ways:
            self.prices.pop((token_out, token_in), None)

    def fund_wallet(self, address: str, token: str, amount: int) -> None:
        """Credit a user's (off-vault) token balance in raw units (what ``open``/``fund`` pull from)."""
        key = (address, token)
        self._state.wallets[key] = self._state.wallets.get(key, 0) + int(amount)

    def wallet_balance(self, address: str, token: str) -> int:
        return self._state.wallets.get((address, token), 0)

    def link_horizon(self, horizon: FakeHorizonGateway) -> None:
        """Classic payments sent through this fake are applied to the linked Horizon fake."""
        self.horizon = horizon

    # --- quotes -----------------------------------------------------------------------------

    def _quote(self, token_in: str, token_out: str, amount_in: int) -> int | None:
        """Router quote or None when there is no route (the contract treats that as 0 / RouterError)."""
        if amount_in <= 0:
            return 0
        if token_in == token_out:
            return int(amount_in)
        frac = self.prices.get((token_in, token_out))
        if frac is None:
            return None
        return int(Fraction(int(amount_in)) * frac)  # floor for positive values

    async def router_amounts_out(self, amount_in: int, path: list[str]) -> list[int]:
        if amount_in <= 0:
            raise ValidationError("amount_in must be positive", code="invalid_amount")
        if len(path) < 2:
            raise ValidationError("path needs at least two tokens", code="invalid_path")
        amounts = [int(amount_in)]
        for a, b in zip(path, path[1:], strict=False):
            q = self._quote(a, b, amounts[-1])
            if q is None:
                raise StellarError(f"no route for {a} -> {b} on the router", code="quote_failed")
            amounts.append(q)
        return amounts

    async def router_quote(self, token_in: str, token_out: str, amount_in: int) -> int:
        if token_in == token_out:
            return int(amount_in)
        return (await self.router_amounts_out(amount_in, [token_in, token_out]))[-1]

    async def quote(self, token_in: str, token_out: str, amount_in: int) -> RouterQuote:
        out = await self.router_quote(token_in, token_out, amount_in)
        return RouterQuote(token_in=token_in, token_out=token_out, amount_in=int(amount_in), amount_out=out, source="fake", path=[token_in, token_out])

    async def soroswap_api_quote(self, token_in: str, token_out: str, amount_in: int, slippage_bps: int | None = None) -> RouterQuote | None:
        canned = self.api_quotes.get((token_in, token_out))
        if canned is None:
            return None
        return RouterQuote(token_in=token_in, token_out=token_out, amount_in=int(amount_in), amount_out=int(canned), source="api")

    # --- reads ------------------------------------------------------------------------------

    async def latest_ledger(self) -> int:
        return self.ledger

    async def account_exists(self, account_id: str) -> bool:
        if self.horizon is not None:
            return await self.horizon.account_exists(account_id)
        return True

    async def load_sequence(self, account_id: str) -> int:
        return self._sequences.get(account_id, 0)

    def _agreement(self, state: _VaultState, agreement_id: int) -> Agreement:
        ag = state.agreements.get(int(agreement_id))
        if ag is None:
            raise VaultContractError(VaultError.NotFound, context=f"agreement {agreement_id}")
        return ag

    async def get_agreement(self, agreement_id: int) -> Agreement:
        return self._agreement(self._state, agreement_id)

    async def get_balances(self, agreement_id: int) -> list[tuple[str, int]]:
        ag = self._agreement(self._state, agreement_id)
        return [(t, self._state.balances.get((ag.id, t), 0)) for t in ag.tokens]

    def _portfolio_value(self, state: _VaultState, ag: Agreement) -> int:
        base = ag.terms.base_token
        total = state.balances.get((ag.id, base), 0)
        for t in ag.tokens:
            if t == base:
                continue
            bal = state.balances.get((ag.id, t), 0)
            if bal <= 0:
                continue
            total += self._quote(t, base, bal) or 0
        return total

    async def value_in_base(self, agreement_id: int) -> int:
        return self._portfolio_value(self._state, self._agreement(self._state, agreement_id))

    async def get_config(self) -> Config:
        return self._state.config

    async def is_token_allowed(self, token: str) -> TokenInfo:
        return self._state.tokens.get(token, TokenInfo())

    async def next_id(self) -> int:
        return self._state.next_id

    async def token_balance(self, token_contract_id: str, holder: str) -> int:
        if holder == self.vault_contract_id:
            return sum(b for (_, t), b in self._state.balances.items() if t == token_contract_id)
        return self._state.wallets.get((holder, token_contract_id), 0)

    # --- state machine (mirrors lib.rs) -----------------------------------------------------

    @staticmethod
    def _require_auth(source: str, who: str, what: str) -> None:
        if source != who:
            raise FakeAuthError(f"{what}: transaction source {source} cannot authorise for {who}")

    def _validate_terms(self, state: _VaultState, terms: Terms) -> None:
        terms.validate()
        info = state.tokens.get(terms.base_token, TokenInfo())
        if not (info.allowed and info.is_base):
            raise VaultContractError(VaultError.TokenNotAllowed, context="base token")

    def _escrow(self, state: _VaultState, ag: Agreement) -> None:
        key = (ag.terms.customer, ag.terms.base_token)
        have = state.wallets.get(key, 0)
        if self.strict_wallets and have < ag.terms.principal:
            raise StellarError(
                f"token transfer failed: {ag.terms.customer} holds {have} < principal {ag.terms.principal}",
                code="simulation_failed",
                details={"simulation_error": "HostError: Error(Contract, #10) [token balance]"},
            )
        state.wallets[key] = have - ag.terms.principal
        state.balances[(ag.id, ag.terms.base_token)] = ag.terms.principal

    def _pay(self, state: _VaultState, to: str, token: str, amount: int) -> None:
        if amount <= 0:
            return
        key = (to, token)
        state.wallets[key] = state.wallets.get(key, 0) + int(amount)

    def _activate(self, state: _VaultState, ag: Agreement) -> tuple[Agreement, VaultEvent]:
        ag = replace(ag, start_time=self.now, end_time=self.now + ag.terms.duration_secs, status=Status.Active)
        state.agreements[ag.id] = ag
        return ag, ActivatedEvent(id=ag.id, start_time=ag.start_time, end_time=ag.end_time)

    def _do_propose(self, state: _VaultState, trader: str, terms: Terms, source: str) -> tuple[int, list[VaultEvent]]:
        self._require_auth(source, trader, "propose")
        if state.config.paused:
            raise VaultContractError(VaultError.Paused, context="propose")
        if trader != terms.trader:
            raise VaultContractError(VaultError.Unauthorized, context="propose")
        self._validate_terms(state, terms)
        ag_id = state.next_id
        state.next_id += 1
        ag = Agreement(ag_id, terms, Status.Proposed, trader, self.now, 0, 0, [terms.base_token])
        state.agreements[ag_id] = ag
        return ag_id, [ProposedEvent(ag_id, terms.trader, terms.customer, terms.principal, terms.base_token)]

    def _do_open(self, state: _VaultState, customer: str, terms: Terms, source: str) -> tuple[int, list[VaultEvent]]:
        self._require_auth(source, customer, "open")
        if state.config.paused:
            raise VaultContractError(VaultError.Paused, context="open")
        if customer != terms.customer:
            raise VaultContractError(VaultError.Unauthorized, context="open")
        self._validate_terms(state, terms)
        ag_id = state.next_id
        state.next_id += 1
        ag = Agreement(ag_id, terms, Status.Funded, customer, self.now, 0, 0, [terms.base_token])
        self._escrow(state, ag)
        state.agreements[ag_id] = ag
        return ag_id, [OpenedEvent(ag_id, terms.trader, terms.customer, terms.principal, terms.base_token)]

    def _do_fund(self, state: _VaultState, ag_id: int, source: str) -> tuple[None, list[VaultEvent]]:
        ag = self._agreement(state, ag_id)
        self._require_auth(source, ag.terms.customer, "fund")
        if state.config.paused:
            raise VaultContractError(VaultError.Paused, context="fund")
        if ag.status is not Status.Proposed:
            raise VaultContractError(VaultError.WrongStatus, context=f"fund: status is {ag.status.label}")
        info = state.tokens.get(ag.terms.base_token, TokenInfo())
        if not (info.allowed and info.is_base):
            raise VaultContractError(VaultError.TokenNotAllowed, context="fund")
        self._escrow(state, ag)
        _, ev = self._activate(state, ag)
        return None, [ev]

    def _do_accept(self, state: _VaultState, ag_id: int, source: str) -> tuple[None, list[VaultEvent]]:
        ag = self._agreement(state, ag_id)
        self._require_auth(source, ag.terms.trader, "accept")
        if state.config.paused:
            raise VaultContractError(VaultError.Paused, context="accept")
        if ag.status is not Status.Funded:
            raise VaultContractError(VaultError.WrongStatus, context=f"accept: status is {ag.status.label}")
        _, ev = self._activate(state, ag)
        return None, [ev]

    def _do_cancel(self, state: _VaultState, ag_id: int, caller: str, source: str) -> tuple[None, list[VaultEvent]]:
        ag = self._agreement(state, ag_id)
        if ag.status is Status.Proposed:
            allowed = caller == ag.proposer
        elif ag.status is Status.Funded:
            allowed = caller in (ag.terms.customer, ag.terms.trader)
        else:
            raise VaultContractError(VaultError.WrongStatus, context=f"cancel: status is {ag.status.label}")
        if not allowed:
            raise VaultContractError(VaultError.NotParty, context="cancel")
        self._require_auth(source, caller, "cancel")
        refunded = 0
        if ag.status is Status.Funded:
            refunded = state.balances.pop((ag.id, ag.terms.base_token), 0)
            self._pay(state, ag.terms.customer, ag.terms.base_token, refunded)
        state.agreements[ag.id] = replace(ag, status=Status.Cancelled)
        return None, [CancelledEvent(ag.id, refunded)]

    def _do_trade(
        self,
        state: _VaultState,
        ag_id: int,
        token_in: str,
        token_out: str,
        amount_in: int,
        min_out: int,
        deadline: int,
        source: str,
    ) -> tuple[int, list[VaultEvent]]:
        cfg = state.config
        ag = self._agreement(state, ag_id)
        self._require_auth(source, ag.terms.trader, "trade")
        if cfg.paused:
            raise VaultContractError(VaultError.Paused, context="trade")
        if ag.status is not Status.Active:
            raise VaultContractError(VaultError.WrongStatus, context=f"trade: status is {ag.status.label}")
        if self.now >= ag.end_time or deadline < self.now:
            raise VaultContractError(VaultError.Expired, context="trade")
        if amount_in <= 0 or min_out <= 0:
            raise VaultContractError(VaultError.InvalidAmount, context="trade")
        if (
            token_in == token_out
            or not state.tokens.get(token_in, TokenInfo()).allowed
            or not state.tokens.get(token_out, TokenInfo()).allowed
        ):
            raise VaultContractError(VaultError.TokenNotAllowed, context="trade")
        bal_in = state.balances.get((ag.id, token_in), 0)
        if bal_in < amount_in:
            raise VaultContractError(VaultError.InsufficientBalance, context="trade")
        tokens = list(ag.tokens)
        if token_out not in tokens:
            if len(tokens) >= MAX_TOKENS:
                raise VaultContractError(VaultError.TooManyTokens, context="trade")
            tokens.append(token_out)
        amount_out = self._quote(token_in, token_out, amount_in)
        if amount_out is None:
            raise VaultContractError(VaultError.RouterError, context="trade: no route")
        if amount_out <= 0 or amount_out < min_out:
            raise VaultContractError(VaultError.SlippageExceeded, context=f"trade: out {amount_out} < min_out {min_out}")
        new_in = bal_in - amount_in
        if new_in == 0 and token_in != ag.terms.base_token:
            state.balances.pop((ag.id, token_in), None)
            tokens.remove(token_in)
        else:
            state.balances[(ag.id, token_in)] = new_in
        state.balances[(ag.id, token_out)] = state.balances.get((ag.id, token_out), 0) + amount_out
        ag = replace(ag, tokens=tokens)
        value_after = self._portfolio_value(state, ag)
        floor = money.drawdown_floor(ag.terms.principal, ag.terms.max_drawdown_bps)
        if value_after < floor:
            raise VaultContractError(
                VaultError.DrawdownBreached, context=f"trade: value {value_after} < floor {floor}"
            )
        state.agreements[ag.id] = ag
        return amount_out, [TradedEvent(ag.id, ag.terms.trader, token_in, token_out, amount_in, amount_out, value_after)]

    def _do_settle(self, state: _VaultState, ag_id: int, caller: str, min_outs: list[int], source: str) -> tuple[None, list[VaultEvent]]:
        cfg = state.config
        ag = self._agreement(state, ag_id)
        if ag.status is not Status.Active:
            raise VaultContractError(VaultError.WrongStatus, context=f"settle: status is {ag.status.label}")
        is_party = caller in (ag.terms.customer, ag.terms.trader)
        if is_party:
            self._require_auth(source, caller, "settle")
            if len(min_outs) != len(ag.tokens) - 1:
                raise VaultContractError(VaultError.InvalidAmount, context="settle: min_outs length")
        elif self.now < ag.end_time:
            raise VaultContractError(VaultError.NotExpired, context="settle")
        base = ag.terms.base_token
        liquidated = 0
        idx = 0
        for token in ag.tokens:
            if token == base:
                continue
            supplied = int(min_outs[idx]) if is_party else 0
            idx += 1
            bal = state.balances.get((ag.id, token), 0)
            if bal <= 0:
                state.balances.pop((ag.id, token), None)
                continue
            if is_party:
                if supplied < 0:
                    raise VaultContractError(VaultError.InvalidAmount, context="settle: negative min_out")
                min_out = supplied
            else:
                q = self._quote(token, base, bal) or 0
                min_out = money.min_out_for_slippage(q, cfg.settle_slippage_bps)
            out = self._quote(token, base, bal)
            if out is None:
                raise VaultContractError(VaultError.RouterError, context=f"settle: no route {token} -> base")
            if out <= 0 or out < min_out:
                raise VaultContractError(VaultError.SlippageExceeded, context=f"settle: out {out} < min_out {min_out}")
            liquidated += out
            state.balances.pop((ag.id, token), None)
        final_value = state.balances.get((ag.id, base), 0) + liquidated
        split = money.settle_math(final_value, ag.terms.principal, ag.terms.commission_bps, cfg.platform_fee_bps)
        self._pay(state, ag.terms.trader, base, split.trader_fee)
        self._pay(state, cfg.fee_recipient, base, split.platform_fee)
        self._pay(state, ag.terms.customer, base, split.customer_payout)
        state.balances.pop((ag.id, base), None)
        state.agreements[ag.id] = replace(
            ag,
            status=Status.Settled,
            settled_at=self.now,
            final_value=final_value,
            trader_fee=split.trader_fee,
            platform_fee=split.platform_fee,
            customer_payout=split.customer_payout,
            tokens=[base],
        )
        return None, [
            SettledEvent(ag.id, final_value, split.profit, split.trader_fee, split.platform_fee, split.customer_payout, caller)
        ]

    def _do_set_token(self, state: _VaultState, token: str, allowed: bool, is_base: bool, source: str) -> tuple[None, list[VaultEvent]]:
        self._require_auth(source, state.config.admin, "set_token")
        info = TokenInfo(allowed=bool(allowed), is_base=bool(allowed and is_base))
        state.tokens[token] = info
        return None, [TokenSetEvent(token, info.allowed, info.is_base)]

    def _config_changed(self, key: str, cfg: Config) -> ConfigChangedEvent:
        return ConfigChangedEvent(key, cfg.router, cfg.platform_fee_bps, cfg.fee_recipient, cfg.paused, cfg.settle_slippage_bps)

    def _do_set_paused(self, state: _VaultState, paused: bool, source: str) -> tuple[None, list[VaultEvent]]:
        self._require_auth(source, state.config.admin, "set_paused")
        state.config = replace(state.config, paused=bool(paused))
        return None, [self._config_changed("paused", state.config)]

    def _do_set_fees(self, state: _VaultState, bps: int, recipient: str, source: str) -> tuple[None, list[VaultEvent]]:
        self._require_auth(source, state.config.admin, "set_fees")
        if bps > abi.MAX_PLATFORM_FEE_BPS:
            raise VaultContractError(VaultError.InvalidTerms, context="set_fees")
        state.config = replace(state.config, platform_fee_bps=int(bps), fee_recipient=recipient)
        return None, [self._config_changed("fees", state.config)]

    # --- execution --------------------------------------------------------------------------

    def _execute(self, apply: Any, *, commit: bool) -> tuple[Any, list[VaultEvent]]:
        """Run ``apply`` on a copy of the state; keep the copy only when ``commit`` and it succeeded."""
        working = copy.deepcopy(self._state)
        result, events = apply(working)
        if commit:
            self._state = working
        return result, events

    def _next_sequence(self, source: str) -> int:
        seq = self._sequences.get(source, 0) + 1
        self._sequences[source] = seq
        return seq

    def _register(self, built: TransactionEnvelope, kind: str, fn: str, source: str, apply: Any, summary: dict[str, Any]) -> UnsignedTx:
        result, _ = self._execute(apply, commit=False)  # dry run == simulation
        xdr = built.to_xdr()
        tx_hash = built.hash_hex()
        expires_at = datetime.now(UTC) + timedelta(seconds=TX_TIMEOUT)
        info: dict[str, Any] = {
            "kind": kind,
            "function": fn,
            "contract_id": self.vault_contract_id if fn else None,
            "source": source,
            "network": "testnet" if self.network_passphrase == TESTNET_PASSPHRASE else "public",
            "fee_stroops": int(built.transaction.fee),
            "sequence": int(built.transaction.sequence),
            "simulated_result": result,
            "fake": True,
        }
        info.update(summary)
        info["expires_at"] = expires_at.isoformat()
        self._pending[tx_hash] = _Pending(kind=kind, fn=fn, source=source, xdr=xdr, apply=apply, summary=info)
        self.calls.append((f"build_{kind}", dict(summary)))
        return UnsignedTx(xdr=xdr, network_passphrase=self.network_passphrase, expires_at=expires_at, summary=info, hash=tx_hash, kind=kind)

    def _invoke(self, fn: str, params: list[sx.SCVal], source: str, kind: str, apply: Any, summary: dict[str, Any]) -> UnsignedTx:
        built = (
            TransactionBuilder(Account(source, self._next_sequence(source)), self.network_passphrase, base_fee=BASE_FEE)
            .append_invoke_contract_function_op(self.vault_contract_id, fn, params)
            .set_timeout(TX_TIMEOUT)
            .build()
        )
        return self._register(built, kind, fn, source, apply, summary)

    async def simulate(self, tx: str | TransactionEnvelope) -> SimulationResult:
        env = tx if isinstance(tx, TransactionEnvelope) else TransactionEnvelope.from_xdr(tx, self.network_passphrase)
        pending = self._pending.get(env.hash_hex())
        if pending is None:
            return SimulationResult(error="HostError: unknown transaction (not built by this fake)", latest_ledger=self.ledger)
        try:
            result, _ = self._execute(pending.apply, commit=False)
        except VaultContractError as e:
            text = f"HostError: Error(Contract, #{e.raw_code})"
            return SimulationResult(error=text, latest_ledger=self.ledger, contract_error_code=e.raw_code)
        except StellarError as e:
            return SimulationResult(error=f"HostError: {e.message}", latest_ledger=self.ledger)
        return SimulationResult(error=None, latest_ledger=self.ledger, min_resource_fee=100_000, result=result)

    async def send(self, signed_xdr: str) -> str:
        env = TransactionEnvelope.from_xdr(signed_xdr, self.network_passphrase)
        tx_hash = env.hash_hex()
        pending = self._pending.pop(tx_hash, None)
        if pending is None:
            if tx_hash in self.results:
                return tx_hash  # DUPLICATE
            raise TxRejectedError("transaction was not built by this gateway", details={"hash": tx_hash, "tx_code": "txMALFORMED"})
        self.sent.append(tx_hash)
        self.ledger += 1
        try:
            result, events = self._execute(pending.apply, commit=True)
        except VaultContractError as e:
            self.results[tx_hash] = TxResult(
                hash=tx_hash,
                status="FAILED",
                ledger=self.ledger,
                created_at=datetime.fromtimestamp(self.now, tz=UTC),
                envelope_xdr=pending.xdr,
                error="tx_failed/op_invoke_host_function_trapped",
                contract_error_code=e.raw_code,
            )
            return tx_hash
        except StellarError as e:
            self.results[tx_hash] = TxResult(
                hash=tx_hash,
                status="FAILED",
                ledger=self.ledger,
                created_at=datetime.fromtimestamp(self.now, tz=UTC),
                envelope_xdr=pending.xdr,
                error=f"tx_failed/{e.code}",
            )
            return tx_hash
        records = self._emit(tx_hash, events)
        self.results[tx_hash] = TxResult(
            hash=tx_hash,
            status="SUCCESS",
            ledger=self.ledger,
            created_at=datetime.fromtimestamp(self.now, tz=UTC),
            envelope_xdr=pending.xdr,
            return_value=result,
            events=records,
        )
        return tx_hash

    def _emit(self, tx_hash: str, events: list[VaultEvent]) -> list[EventRecord]:
        records: list[EventRecord] = []
        for idx, ev in enumerate(events):
            topics, data = ev.to_xdr()
            rec = EventRecord(
                id=f"{self.ledger:019d}-{idx:010d}",
                ledger=self.ledger,
                contract_id=self.vault_contract_id,
                tx_hash=tx_hash,
                topics_xdr=topics,
                value_xdr=data,
                ledger_close_at=datetime.fromtimestamp(self.now, tz=UTC),
                event_index=idx,
                decoded=ev,
            )
            self.events.append(rec)
            records.append(rec)
        return records

    async def get_transaction(self, tx_hash: str) -> TxResult:
        return self.results.get(tx_hash) or TxResult(hash=tx_hash, status="NOT_FOUND")

    async def poll_tx(self, tx_hash: str, timeout: float | None = None) -> TxResult:  # noqa: ASYNC109 - API name from DESIGN
        return await self.get_transaction(tx_hash)

    async def get_events(
        self,
        start_ledger: int | None = None,
        cursor: str | None = None,
        contract_id: str | None = None,
        limit: int = 100,
        topics: list[list[str]] | None = None,
    ) -> tuple[list[EventRecord], str | None, int]:
        cid = contract_id or self.vault_contract_id
        selected = [e for e in self.events if e.contract_id == cid]
        if cursor:
            selected = [e for e in selected if e.id > cursor]
        elif start_ledger is not None:
            selected = [e for e in selected if e.ledger >= int(start_ledger)]
        page = selected[: max(1, int(limit))]
        next_cursor = page[-1].id if page else cursor
        return page, next_cursor, self.ledger

    # --- builders (same signatures as SorobanGateway) ---------------------------------------

    async def build_open(self, customer: str, terms: Terms) -> UnsignedTx:
        terms.validate()
        return self._invoke(
            Fn.OPEN,
            abi.args_open(customer, terms),
            customer,
            "open",
            lambda st: self._do_open(st, customer, terms, customer),
            {"terms": terms.as_dict()},
        )

    async def build_propose(self, trader: str, terms: Terms) -> UnsignedTx:
        terms.validate()
        return self._invoke(
            Fn.PROPOSE,
            abi.args_propose(trader, terms),
            trader,
            "propose",
            lambda st: self._do_propose(st, trader, terms, trader),
            {"terms": terms.as_dict()},
        )

    async def build_fund(self, customer: str, agreement_id: int) -> UnsignedTx:
        return self._invoke(
            Fn.FUND,
            abi.args_id(agreement_id),
            customer,
            "fund",
            lambda st: self._do_fund(st, int(agreement_id), customer),
            {"agreement_id": int(agreement_id)},
        )

    async def build_accept(self, trader: str, agreement_id: int) -> UnsignedTx:
        return self._invoke(
            Fn.ACCEPT,
            abi.args_id(agreement_id),
            trader,
            "accept",
            lambda st: self._do_accept(st, int(agreement_id), trader),
            {"agreement_id": int(agreement_id)},
        )

    async def build_cancel(self, who: str, agreement_id: int) -> UnsignedTx:
        return self._invoke(
            Fn.CANCEL,
            abi.args_cancel(agreement_id, who),
            who,
            "cancel",
            lambda st: self._do_cancel(st, int(agreement_id), who, who),
            {"agreement_id": int(agreement_id), "caller": who},
        )

    async def build_trade(
        self, trader: str, agreement_id: int, token_in: str, token_out: str, amount_in: int, min_out: int, deadline: int
    ) -> UnsignedTx:
        if amount_in <= 0 or min_out <= 0:
            raise VaultContractError(VaultError.InvalidAmount, context="trade")
        if token_in == token_out:
            raise VaultContractError(VaultError.TokenNotAllowed, context="trade: token_in == token_out")
        return self._invoke(
            Fn.TRADE,
            abi.args_trade(agreement_id, token_in, token_out, amount_in, min_out, deadline),
            trader,
            "trade",
            lambda st: self._do_trade(st, int(agreement_id), token_in, token_out, int(amount_in), int(min_out), int(deadline), trader),
            {
                "agreement_id": int(agreement_id),
                "token_in": token_in,
                "token_out": token_out,
                "amount_in": int(amount_in),
                "min_out": int(min_out),
                "deadline": int(deadline),
            },
        )

    async def build_settle(self, caller: str, agreement_id: int, min_outs: list[int]) -> UnsignedTx:
        mins = [int(m) for m in min_outs]
        if any(m < 0 for m in mins):
            raise VaultContractError(VaultError.InvalidAmount, context="settle: negative min_out")
        return self._invoke(
            Fn.SETTLE,
            abi.args_settle(agreement_id, caller, mins),
            caller,
            "settle",
            lambda st: self._do_settle(st, int(agreement_id), caller, mins, caller),
            {"agreement_id": int(agreement_id), "caller": caller, "min_outs": mins},
        )

    async def build_set_token(self, admin: str, token: str, allowed: bool, is_base: bool) -> UnsignedTx:
        return self._invoke(
            Fn.SET_TOKEN,
            abi.args_set_token(token, allowed, is_base),
            admin,
            "admin",
            lambda st: self._do_set_token(st, token, allowed, is_base, admin),
            {"token": token, "allowed": bool(allowed), "is_base": bool(is_base)},
        )

    async def build_set_paused(self, admin: str, paused: bool) -> UnsignedTx:
        return self._invoke(
            Fn.SET_PAUSED, abi.args_set_paused(paused), admin, "admin", lambda st: self._do_set_paused(st, paused, admin), {"paused": bool(paused)}
        )

    async def build_set_fees(self, admin: str, platform_fee_bps: int, fee_recipient: str) -> UnsignedTx:
        return self._invoke(
            Fn.SET_FEES,
            abi.args_set_fees(platform_fee_bps, fee_recipient),
            admin,
            "admin",
            lambda st: self._do_set_fees(st, int(platform_fee_bps), fee_recipient, admin),
            {"platform_fee_bps": int(platform_fee_bps), "fee_recipient": fee_recipient},
        )

    async def build_payment(
        self,
        source: str,
        destination: str,
        asset_code: str,
        issuer: str | None,
        amount: Decimal | str,
        memo: str | int | None = None,
        memo_type: str | None = None,
    ) -> UnsignedTx:
        ref = AssetRef.of(asset_code, issuer)
        amt = Decimal(str(amount))
        if amt <= 0:
            raise ValidationError("amount must be positive", code="invalid_amount")
        if source == destination:
            raise ValidationError("destination must differ from the source", code="invalid_destination")
        builder = TransactionBuilder(Account(source, self._next_sequence(source)), self.network_passphrase, base_fee=BASE_FEE)
        op = "payment"
        if self.horizon is not None and not await self.horizon.account_exists(destination):
            if not ref.is_native:
                raise AccountNotFoundError(f"destination {destination} does not exist", details={"account": destination})
            op = "create_account"
            builder.append_create_account_op(destination, amount_str(amt))
        else:
            builder.append_payment_op(destination, to_sdk_asset(ref), amount_str(amt))
        apply_memo(builder, memo, memo_type)
        built = builder.set_timeout(TX_TIMEOUT).build()
        summary = {
            "operation": op,
            "source": source,
            "destination": destination,
            "asset": ref.canonical,
            "asset_code": ref.code,
            "asset_issuer": ref.issuer,
            "amount": amount_str(amt),
            "memo": memo,
            "memo_type": memo_type if memo not in (None, "") else None,
        }
        return self._register_classic(built, "payment", source, summary)

    def _register_classic(self, built: TransactionEnvelope, kind: str, source: str, summary: dict[str, Any]) -> UnsignedTx:
        """Classic tx whose effect lives in the linked Horizon fake (applied on send)."""
        horizon = self.horizon

        def _apply(_: _VaultState) -> tuple[None, list[VaultEvent]]:
            if horizon is not None:
                horizon.apply_envelope(built)
            return None, []

        # dry-run must not mutate Horizon: register without executing, then validate via a parse only
        xdr = built.to_xdr()
        tx_hash = built.hash_hex()
        expires_at = datetime.now(UTC) + timedelta(seconds=TX_TIMEOUT)
        info: dict[str, Any] = {
            "kind": kind,
            "function": None,
            "contract_id": None,
            "source": source,
            "network": "testnet" if self.network_passphrase == TESTNET_PASSPHRASE else "public",
            "fee_stroops": int(built.transaction.fee),
            "sequence": int(built.transaction.sequence),
            "simulated_result": None,
            "fake": True,
        }
        info.update(summary)
        info["expires_at"] = expires_at.isoformat()
        self._pending[tx_hash] = _Pending(kind=kind, fn="", source=source, xdr=xdr, apply=_apply, summary=info)
        self.calls.append((f"build_{kind}", dict(summary)))
        return UnsignedTx(xdr=xdr, network_passphrase=self.network_passphrase, expires_at=expires_at, summary=info, hash=tx_hash, kind=kind)

    async def build_change_trust(self, source: str, asset_code: str, issuer: str, limit: Decimal | str | None = None) -> UnsignedTx:
        ref = AssetRef.of(asset_code, issuer)
        if ref.is_native:
            raise ValidationError("native XLM needs no trustline", code="invalid_asset")
        builder = TransactionBuilder(Account(source, self._next_sequence(source)), self.network_passphrase, base_fee=BASE_FEE)
        builder.append_change_trust_op(to_sdk_asset(ref), limit=amount_str(limit) if limit is not None else None)
        built = builder.set_timeout(TX_TIMEOUT).build()
        summary = {"source": source, "asset": ref.canonical, "asset_code": ref.code, "asset_issuer": ref.issuer, "limit": amount_str(limit) if limit is not None else None}
        return self._register_classic(built, "trustline", source, summary)


# --- Horizon fake ----------------------------------------------------------------------------


@dataclass
class _FakeAccount:
    account_id: str
    sequence: int = 0
    balances: dict[str, Decimal] = field(default_factory=dict)  # canonical -> amount
    trustlines: set[str] = field(default_factory=set)  # canonical of issued assets

    def credit(self, asset: AssetRef, amount: Decimal) -> None:
        self.balances[asset.canonical] = self.balances.get(asset.canonical, Decimal("0")) + amount

    def debit(self, asset: AssetRef, amount: Decimal) -> None:
        self.balances[asset.canonical] = self.balances.get(asset.canonical, Decimal("0")) - amount


class FakeHorizonGateway:
    """Drop-in for ``HorizonGateway`` with an in-memory classic ledger."""

    def __init__(self, settings: Any | None = None, *, network_passphrase: str | None = None) -> None:
        self._settings = settings
        self.network_passphrase = network_passphrase or getattr(settings, "network_passphrase", None) or TESTNET_PASSPHRASE
        self.horizon_url = "fake://horizon"
        self.accounts: dict[str, _FakeAccount] = {}
        self.payments: list[PaymentRecord] = []
        self.transactions: dict[str, SubmitResult] = {}
        self.ledger = 1000
        self._paging = 0
        self.friendbot_calls: list[str] = []

    # --- setup helpers ----------------------------------------------------------------------

    def _acct(self, account_id: str) -> _FakeAccount | None:
        return self.accounts.get(account_id)

    def _paging_token(self) -> str:
        self._paging += 1
        return f"{self._paging:020d}"

    def _record(self, source: str, destination: str, asset: AssetRef, amount: Decimal, *, memo: str | None, memo_type: str | None, op_type: str, tx_hash: str) -> PaymentRecord:
        rec = PaymentRecord(
            op_id=str(self._paging + 1),
            paging_token=self._paging_token(),
            tx_hash=tx_hash,
            source_account=source,
            destination=destination,
            asset=asset,
            amount=amount,
            memo=memo,
            memo_type=memo_type,
            created_at=datetime.now(UTC).isoformat(),
            op_type=op_type,
        )
        self.payments.append(rec)
        return rec

    def fund(self, account_id: str, amount: Decimal | str = Decimal("10000")) -> _FakeAccount:
        """Create (or top up) an account with XLM, like friendbot."""
        amt = Decimal(str(amount))
        acct = self._acct(account_id)
        self.ledger += 1
        tx_hash = f"fake-fund-{self.ledger}-{account_id[:8]}"
        if acct is None:
            acct = _FakeAccount(account_id=account_id, sequence=self.ledger << 32)
            self.accounts[account_id] = acct
            acct.credit(AssetRef.native(), amt)
            self._record(FAKE_FRIENDBOT, account_id, AssetRef.native(), amt, memo=None, memo_type=None, op_type="create_account", tx_hash=tx_hash)
        else:
            acct.credit(AssetRef.native(), amt)
            self._record(FAKE_FRIENDBOT, account_id, AssetRef.native(), amt, memo=None, memo_type=None, op_type="payment", tx_hash=tx_hash)
        return acct

    def add_trustline(self, account_id: str, asset_code: str, issuer: str) -> None:
        acct = self._acct(account_id)
        if acct is None:
            raise AccountNotFoundError(f"account {account_id} does not exist", details={"account": account_id})
        ref = AssetRef(asset_code, issuer)
        acct.trustlines.add(ref.canonical)
        acct.balances.setdefault(ref.canonical, Decimal("0"))

    def deposit_from_anchor(
        self,
        account_id: str,
        asset_code: str,
        issuer: str | None,
        amount: Decimal | str,
        memo: str | None = None,
        *,
        anchor_account: str = FAKE_ANCHOR_ACCOUNT,
    ) -> PaymentRecord:
        """What a SEP-24 deposit looks like on-chain: a classic payment from the anchor to the user."""
        acct = self._acct(account_id)
        if acct is None:
            raise AccountNotFoundError(f"account {account_id} does not exist", details={"account": account_id})
        ref = AssetRef.of(asset_code, issuer)
        if not ref.is_native and ref.canonical not in acct.trustlines:
            raise TxRejectedError(
                f"{account_id} has no trustline for {ref.canonical}", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_no_trust"]}}
            )
        amt = Decimal(str(amount))
        acct.credit(ref, amt)
        self.ledger += 1
        return self._record(
            anchor_account, account_id, ref, amt, memo=memo, memo_type="text" if memo else None, op_type="payment", tx_hash=f"fake-anchor-{self.ledger}"
        )

    # --- reads ------------------------------------------------------------------------------

    async def get_account(self, account_id: str) -> AccountInfo | None:
        acct = self._acct(account_id)
        if acct is None:
            return None
        balances = [Balance(asset=AssetRef.parse(c), balance=b) for c, b in acct.balances.items()]
        return AccountInfo(account_id=account_id, sequence=acct.sequence, balances=balances, subentry_count=len(acct.trustlines))

    async def account_exists(self, account_id: str) -> bool:
        return account_id in self.accounts

    async def get_account_signers(self, account_id: str) -> AccountSigners | None:
        if account_id not in self.accounts:
            return None
        return AccountSigners(account_id=account_id, signers=[(account_id, 1)], low_threshold=0, med_threshold=0, high_threshold=0)

    async def has_trustline(self, account_id: str, asset_code: str, issuer: str | None) -> bool:
        ref = AssetRef.of(asset_code, issuer)
        if ref.is_native:
            return True
        acct = self._acct(account_id)
        return acct is not None and ref.canonical in acct.trustlines

    async def fetch_payments(self, account_id: str, cursor: str | None, limit: int = 100) -> tuple[list[PaymentRecord], str | None]:
        out: list[PaymentRecord] = []
        for rec in self.payments:
            if cursor and rec.paging_token <= cursor:
                continue
            if rec.destination == account_id or rec.source_account == account_id:
                out.append(rec)
            if len(out) >= limit:
                break
        return out, (out[-1].paging_token if out else cursor)

    async def get_transaction(self, tx_hash: str) -> SubmitResult | None:
        return self.transactions.get(tx_hash)

    async def horizon_health(self) -> dict[str, Any]:
        return {"horizon_url": self.horizon_url, "history_latest_ledger": self.ledger, "network_passphrase": self.network_passphrase}

    async def fund_with_friendbot(self, account_id: str) -> None:
        self.friendbot_calls.append(account_id)
        self.fund(account_id)

    # --- unsigned tx / submit ---------------------------------------------------------------

    async def build_payment_xdr(
        self,
        source_account_id: str,
        destination: str,
        asset: AssetRef,
        amount: Decimal,
        memo_text: str | None = None,
        *,
        memo: str | int | None = None,
        memo_type: str | None = None,
    ) -> str:
        if memo_text is not None:
            memo, memo_type = memo_text, "text"
        acct = self._acct(source_account_id)
        if acct is None:
            raise AccountNotFoundError(f"account {source_account_id} does not exist", details={"account": source_account_id})
        builder = TransactionBuilder(Account(source_account_id, acct.sequence), self.network_passphrase, base_fee=BASE_FEE)
        builder.append_payment_op(destination, to_sdk_asset(asset), amount_str(amount))
        apply_memo(builder, memo, memo_type)
        return builder.set_timeout(TX_TIMEOUT).build().to_xdr()

    async def build_payment(
        self, source_account_id: str, destination: str, asset: AssetRef, amount: Decimal, memo: str | int | None = None, memo_type: str | None = None
    ) -> UnsignedTx:
        xdr = await self.build_payment_xdr(source_account_id, destination, asset, amount, memo=memo, memo_type=memo_type)
        env = TransactionEnvelope.from_xdr(xdr, self.network_passphrase)
        return UnsignedTx(
            xdr=xdr,
            network_passphrase=self.network_passphrase,
            expires_at=datetime.now(UTC) + timedelta(seconds=TX_TIMEOUT),
            summary={"kind": "payment", "source": source_account_id, "destination": destination, "asset": asset.canonical, "amount": amount_str(amount), "memo": memo, "memo_type": memo_type},
            hash=env.hash_hex(),
            kind="payment",
        )

    def parse_payment_xdr(self, xdr: str) -> tuple[str, str, AssetRef, Decimal, str | None]:
        return parse_payment_envelope(xdr, self.network_passphrase)

    def apply_envelope(self, envelope: TransactionEnvelope | str) -> SubmitResult:
        """Apply payment / create_account / change_trust operations of an envelope to the fake ledger."""
        env = envelope if isinstance(envelope, TransactionEnvelope) else TransactionEnvelope.from_xdr(envelope, self.network_passphrase)
        tx = env.transaction
        tx_source = tx.source.account_id
        src_acct = self._acct(tx_source)
        if src_acct is None:
            raise TxRejectedError("source account does not exist", details={"result_codes": {"transaction": "tx_no_account"}})
        memo = memo_text_of(tx.memo) if tx.memo.__class__.__name__ in ("TextMemo", "NoneMemo") else None
        memo_type = "text" if memo is not None else (None if tx.memo.__class__.__name__ == "NoneMemo" else tx.memo.__class__.__name__.replace("Memo", "").lower())
        tx_hash = env.hash_hex()
        self.ledger += 1
        # validate all ops first (atomic like the network)
        ops_plan: list[tuple[str, Any]] = []
        for op in tx.operations:
            op_source = (op.source or tx.source).account_id
            payer = self._acct(op_source)
            if payer is None:
                raise TxRejectedError("operation source does not exist", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_no_account"]}})
            if isinstance(op, Payment):
                ref = from_sdk_asset(op.asset)
                amt = Decimal(str(op.amount))
                dest = self._acct(op.destination.account_id)
                if dest is None:
                    raise TxRejectedError("destination does not exist", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_no_destination"]}})
                if not ref.is_native and ref.canonical not in dest.trustlines:
                    raise TxRejectedError("destination has no trustline", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_no_trust"]}})
                if payer.balances.get(ref.canonical, Decimal("0")) < amt:
                    raise TxRejectedError("insufficient balance", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_underfunded"]}})
                ops_plan.append(("payment", (payer, dest, ref, amt)))
            elif isinstance(op, CreateAccount):
                amt = Decimal(str(op.starting_balance))
                if op.destination in self.accounts:
                    raise TxRejectedError("account already exists", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_already_exists"]}})
                if payer.balances.get("native", Decimal("0")) < amt:
                    raise TxRejectedError("insufficient balance", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_underfunded"]}})
                ops_plan.append(("create_account", (payer, op.destination, amt)))
            elif isinstance(op, ChangeTrust):
                ref = from_sdk_asset(op.asset)  # type: ignore[arg-type]
                ops_plan.append(("change_trust", (payer, ref, op.limit)))
            else:
                raise TxRejectedError(f"unsupported operation {type(op).__name__}", details={"result_codes": {"transaction": "tx_failed", "operations": ["op_not_supported"]}})
        for kind, plan in ops_plan:
            if kind == "payment":
                payer, dest, ref, amt = plan
                payer.debit(ref, amt)
                dest.credit(ref, amt)
                self._record(payer.account_id, dest.account_id, ref, amt, memo=memo, memo_type=memo_type, op_type="payment", tx_hash=tx_hash)
            elif kind == "create_account":
                payer, destination, amt = plan
                payer.debit(AssetRef.native(), amt)
                self.accounts[destination] = _FakeAccount(account_id=destination, sequence=self.ledger << 32)
                self.accounts[destination].credit(AssetRef.native(), amt)
                self._record(payer.account_id, destination, AssetRef.native(), amt, memo=memo, memo_type=memo_type, op_type="create_account", tx_hash=tx_hash)
            else:
                payer, ref, limit = plan
                if limit is not None and Decimal(str(limit)) == 0:
                    payer.trustlines.discard(ref.canonical)
                    payer.balances.pop(ref.canonical, None)
                else:
                    payer.trustlines.add(ref.canonical)
                    payer.balances.setdefault(ref.canonical, Decimal("0"))
        src_acct.sequence = max(src_acct.sequence, int(tx.sequence))
        result = SubmitResult(hash=tx_hash, ledger=self.ledger, successful=True, fee_charged_stroops=int(tx.fee), result_xdr="", envelope_xdr=env.to_xdr())
        self.transactions[tx_hash] = result
        return result

    async def submit_xdr(self, signed_xdr: str) -> SubmitResult:
        if not isinstance(signed_xdr, str) or not signed_xdr.strip():
            raise StellarError("empty transaction XDR", code="invalid_xdr")
        return self.apply_envelope(signed_xdr.strip())

    async def close(self) -> None:  # pragma: no cover - parity with the real gateway
        return None


__all__ = [
    "DEFAULT_NOW",
    "FAKE_ADMIN",
    "FAKE_ANCHOR_ACCOUNT",
    "FAKE_VAULT_ID",
    "TESTNET_CIRCLE_USDC",
    "TESTNET_EURC",
    "TESTNET_USDC",
    "TESTNET_XLM",
    "FakeAuthError",
    "FakeHorizonGateway",
    "FakeSorobanGateway",
]
