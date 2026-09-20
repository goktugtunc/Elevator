"""Plain data types exchanged with the Stellar gateways.

No stellar_sdk objects leak out of ``app.services.stellar``: XDR is carried as base64 strings, amounts as
``Decimal`` (classic, 7 dp) or ``int`` raw units (Soroban i128), addresses as ``G...``/``C...`` strings.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.core.errors import StellarError

# --- errors ----------------------------------------------------------------------------------


class AccountNotFoundError(StellarError):
    """The source/destination account does not exist on the ledger (not funded yet)."""

    status_code = 400
    code = "account_not_found"


class TxRejectedError(StellarError):
    """The network rejected or failed a transaction (result codes in ``details``)."""

    status_code = 400
    code = "tx_failed"


# --- classic assets / accounts ---------------------------------------------------------------


@dataclass(frozen=True)
class AssetRef:
    """Canonical classic asset identity. issuer None => native XLM."""

    code: str
    issuer: str | None = None

    @property
    def is_native(self) -> bool:
        return self.issuer is None

    @property
    def canonical(self) -> str:
        return "native" if self.is_native else f"{self.code}:{self.issuer}"

    @classmethod
    def native(cls) -> AssetRef:
        return cls("XLM", None)

    @classmethod
    def parse(cls, s: str) -> AssetRef:
        if s in ("native", "XLM"):
            return cls.native()
        code, issuer = s.split(":", 1)
        return cls(code, issuer)

    @classmethod
    def of(cls, code: str, issuer: str | None) -> AssetRef:
        """``(code, issuer)`` -> AssetRef; ``("XLM", None)`` / ``("native", None)`` are native."""
        if issuer is None:
            if code.upper() not in ("XLM", "NATIVE"):
                raise StellarError(f"asset {code} needs an issuer", code="invalid_asset")
            return cls.native()
        return cls(code, issuer)


@dataclass(frozen=True)
class Balance:
    asset: AssetRef
    balance: Decimal  # total balance (includes selling liabilities held in open offers)
    selling_liabilities: Decimal = Decimal("0")
    buying_liabilities: Decimal = Decimal("0")
    limit: Decimal | None = None

    @property
    def available(self) -> Decimal:
        return self.balance - self.selling_liabilities


@dataclass(frozen=True)
class AccountInfo:
    account_id: str
    sequence: int
    balances: list[Balance]
    subentry_count: int
    num_sponsoring: int = 0
    num_sponsored: int = 0

    def balance_of(self, asset: AssetRef) -> Balance | None:
        for b in self.balances:
            if b.asset == asset:
                return b
        return None

    def has_trustline(self, asset: AssetRef) -> bool:
        return asset.is_native or self.balance_of(asset) is not None


@dataclass(frozen=True)
class AccountSigners:
    """Signer set of an on-chain account (what ``sep10.verify_challenge`` needs for multisig accounts)."""

    account_id: str
    signers: list[tuple[str, int]]  # (ed25519 public key, weight); includes the master key
    low_threshold: int = 0
    med_threshold: int = 0
    high_threshold: int = 0


@dataclass(frozen=True)
class SubmitResult:
    hash: str
    ledger: int
    successful: bool
    fee_charged_stroops: int
    result_xdr: str
    envelope_xdr: str

    @property
    def fee_charged_xlm(self) -> Decimal:
        return Decimal(self.fee_charged_stroops) / Decimal(10**7)


@dataclass(frozen=True)
class PaymentRecord:
    """A payment-like operation received/sent by an account (from Horizon /payments)."""

    op_id: str
    paging_token: str
    tx_hash: str
    source_account: str  # sender of the funds (op source / from)
    destination: str
    asset: AssetRef
    amount: Decimal
    memo: str | None  # text memo of the transaction (None if absent / non-text)
    memo_type: str | None
    created_at: str  # ISO timestamp from Horizon
    op_type: str  # payment | path_payment_strict_send | path_payment_strict_receive | create_account


# --- Soroban ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class UnsignedTx:
    """Simulated & assembled transaction for the *user* to sign (DESIGN §2.4).

    ``hash`` is the transaction hash, which signing does not change, so it can be recorded before
    the signed envelope comes back. ``summary`` is a JSON-serialisable description for the client
    ("what am I signing?") and for ``pending_transactions.payload``.
    """

    xdr: str
    network_passphrase: str
    expires_at: datetime
    summary: dict[str, Any]
    hash: str = ""
    kind: str = ""


@dataclass(frozen=True)
class SimulationResult:
    """Outcome of ``simulateTransaction``."""

    error: str | None
    latest_ledger: int
    min_resource_fee: int | None = None
    result_xdr: str | None = None  # SCVal XDR of the host function return value
    result: Any = None  # ``scval.to_native`` of the return value (Address -> str)
    transaction_data_xdr: str | None = None
    restore_needed: bool = False
    contract_error_code: int | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass(frozen=True)
class EventRecord:
    """One contract event, as returned by ``getEvents`` or extracted from a transaction's meta."""

    id: str
    ledger: int
    contract_id: str
    tx_hash: str
    topics_xdr: list[str]  # base64 SCVal XDR per topic
    value_xdr: str  # base64 SCVal XDR of the data
    ledger_close_at: datetime | None = None
    event_index: int = 0  # position of the event inside its transaction (Trade.onchain_seq)
    operation_index: int = 0
    transaction_index: int = 0
    in_successful_contract_call: bool = True
    event_type: str = "contract"
    decoded: Any = None  # app.services.stellar.contract_abi.VaultEvent | None


@dataclass(frozen=True)
class TxResult:
    """Outcome of ``getTransaction`` (after ``poll_tx``)."""

    hash: str
    status: str  # SUCCESS | FAILED | NOT_FOUND
    ledger: int | None = None
    created_at: datetime | None = None
    envelope_xdr: str | None = None
    result_xdr: str | None = None
    result_meta_xdr: str | None = None
    return_value_xdr: str | None = None
    return_value: Any = None  # native decoding of the host function return value
    error: str | None = None  # tx result code (txFAILED, txBAD_AUTH, ...) or host error text
    contract_error_code: int | None = None  # vault #[contracterror] code when the failure was one
    events: list[EventRecord] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.status == "SUCCESS"

    @property
    def pending(self) -> bool:
        return self.status == "NOT_FOUND"


@dataclass(frozen=True)
class RouterQuote:
    token_in: str
    token_out: str
    amount_in: int
    amount_out: int
    source: str = "router"  # router (on-chain simulation) | api (Soroswap API) | fake
    path: list[str] = field(default_factory=list)
    price_impact_pct: Decimal | None = None
    raw: dict[str, Any] | None = None


__all__ = [
    "AccountInfo",
    "AccountNotFoundError",
    "AccountSigners",
    "AssetRef",
    "Balance",
    "EventRecord",
    "PaymentRecord",
    "RouterQuote",
    "SimulationResult",
    "SubmitResult",
    "TxRejectedError",
    "TxResult",
    "UnsignedTx",
]
