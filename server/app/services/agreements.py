"""Agreements (Sözleşme) lifecycle: role-aware list/get with TL equivalents, the action rules and the
unsigned transaction builders (DESIGN §2.3 "Agreements", §2.4 signing model).

State machine (contract = source of truth, rows = indexed mirror):

    draft ──open (customer)──▶ funded ──accept (trader)──▶ active ──settle──▶ settled
    draft ──propose (trader)─▶ proposed ──fund (customer)─▶ active
    proposed ──cancel (proposer)──▶ cancelled      funded ──cancel (customer|trader)──▶ cancelled

Every builder simulates through the Soroban gateway with source = the caller, records a
`pending_transactions` row and hands the unsigned XDR back; nothing here signs or submits.
"""
from __future__ import annotations

import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import ForbiddenError, NotFoundError, StateError, StellarError, ValidationError
from app.models import (
    Agreement,
    AgreementStatus,
    AgreementValueSnapshot,
    Asset,
    PendingTransaction,
    PendingTxKind,
    PendingTxStatus,
    Trade,
    User,
    UserRole,
)
from app.schemas.agreements import (
    STATUS_GROUPS,
    AgreementOut,
    AssetBriefOut,
    BalanceOut,
    PartyOut,
    PendingTxBriefOut,
    TlOut,
    ValueHistoryOut,
    ValuePointOut,
    ValueRange,
)
from app.schemas.tx import UnsignedTxOut
from app.services import amounts as money
from app.services import fx
from app.services.stellar.contract_abi import Terms
from app.services.stellar.types import UnsignedTx

log = logging.getLogger(__name__)

OPEN_STATUSES = (AgreementStatus.proposed, AgreementStatus.funded, AgreementStatus.active)
CLOSED_STATUSES = (AgreementStatus.settled, AgreementStatus.cancelled, AgreementStatus.failed)
ACTIONS = ("open", "propose", "fund", "accept", "cancel", "settle")
_RANGE_DELTA: dict[str, timedelta | None] = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
    "all": None,
}
XLM_PRICE_CACHE_SECONDS = 60
ZERO = Decimal("0")


# --- small helpers ------------------------------------------------------------------------------


def now_utc() -> datetime:
    return datetime.now(UTC)


def ts_to_dt(ts: int | None) -> datetime | None:
    """On-chain unix seconds -> aware datetime (0 means "unset" on-chain)."""
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=UTC)


def json_safe(value: Any) -> Any:
    """JSONB / response friendly copy: Decimal, UUID, datetime, bytes -> str/hex; tuples -> lists."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [json_safe(v) for v in value]
    if isinstance(value, bool | int | float | str) or value is None:
        return value
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def compute_listing_ref(ref_id: uuid.UUID | str) -> str:
    """`listing_ref` = sha256 of the off-chain offer (or agreement) id, hex (DESIGN §1.1)."""
    return hashlib.sha256(str(ref_id).encode("utf-8")).hexdigest()


def listing_ref_bytes(agreement: Agreement) -> bytes:
    """32 raw bytes for `Terms.listing_ref`; repairs a missing/invalid hex value on the row."""
    raw = (agreement.listing_ref or "").strip().lower()
    try:
        data = bytes.fromhex(raw)
    except ValueError:
        data = b""
    if len(data) != 32:
        fixed = compute_listing_ref(agreement.offer_id or agreement.id)
        agreement.listing_ref = fixed
        data = bytes.fromhex(fixed)
    return data


def principal_raw(agreement: Agreement) -> int:
    dec = agreement.base_asset.decimals
    return money.to_stroops(money.quantize(agreement.principal, dec), dec)


def build_terms(agreement: Agreement) -> Terms:
    """On-chain `Terms` from the draft row (addresses from the party users, raw units from Decimal)."""
    return Terms(
        customer=agreement.customer.stellar_address,
        trader=agreement.trader.stellar_address,
        base_token=agreement.base_asset.contract_id,
        principal=principal_raw(agreement),
        duration_secs=int(agreement.duration_secs),
        commission_bps=int(agreement.commission_bps),
        max_drawdown_bps=int(agreement.max_drawdown_bps),
        listing_ref=listing_ref_bytes(agreement),
    )


SETTLE_GRACE = timedelta(days=7)  # mirrors contracts/vault/src/types.rs SETTLE_GRACE_SECS


def party_role(agreement: Agreement, user: User | None) -> UserRole | None:
    return agreement.party_role(user.id) if user is not None else None


def is_expired(agreement: Agreement, now: datetime | None = None) -> bool:
    return agreement.end_time is not None and (now or now_utc()) >= agreement.end_time


def pnl_bps(value: Decimal | None, principal: Decimal | None) -> int | None:
    if value is None or principal is None or principal <= 0:
        return None
    return int(((Decimal(value) - Decimal(principal)) * 10_000 / Decimal(principal)).to_integral_value())


def drawdown_bps(value: Decimal | None, principal: Decimal) -> int:
    """Current drawdown from principal in bps (0 when at or above principal)."""
    if value is None or principal <= 0 or value >= principal:
        return 0
    return int(((principal - Decimal(value)) * 10_000 / principal).to_integral_value())


# --- lookups ------------------------------------------------------------------------------------


async def get_agreement_row(db: AsyncSession, agreement_id: uuid.UUID) -> Agreement:
    ag = await db.get(Agreement, agreement_id)
    if ag is None:
        raise NotFoundError("Agreement not found", code="agreement_not_found")
    return ag


async def get_agreement_for(db: AsyncSession, agreement_id: uuid.UUID, user: User) -> Agreement:
    """Agreement the user may see: a party (customer/trader) or an admin. Others get 403."""
    ag = await get_agreement_row(db, agreement_id)
    if party_role(ag, user) is None and not user.is_admin:
        raise ForbiddenError("You are not a party of this agreement", code="not_party")
    return ag


def parse_status_filter(status: str | None) -> list[AgreementStatus] | None:
    if status is None or status == "":
        return None
    if status in STATUS_GROUPS:
        return list(OPEN_STATUSES) if status == "open" else list(CLOSED_STATUSES)
    try:
        return [AgreementStatus(status)]
    except ValueError as e:
        raise ValidationError(
            f"unknown status {status!r}", code="invalid_status", details={"allowed": [*AgreementStatus, *STATUS_GROUPS]}
        ) from e


async def list_agreements(
    db: AsyncSession,
    user: User,
    *,
    role: UserRole | None = None,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[Agreement], int]:
    """Agreements the user is party to. `role` narrows to the side they play (customer|trader)."""
    if role is UserRole.customer:
        where = [Agreement.customer_id == user.id]
    elif role is UserRole.trader:
        where = [Agreement.trader_id == user.id]
    else:
        where = [or_(Agreement.customer_id == user.id, Agreement.trader_id == user.id)]
    statuses = parse_status_filter(status)
    if statuses:
        where.append(Agreement.status.in_(statuses))
    total = int((await db.execute(select(func.count()).select_from(Agreement).where(*where))).scalar_one())
    rows = (
        await db.execute(
            select(Agreement)
            .where(*where)
            .order_by(Agreement.updated_at.desc(), Agreement.created_at.desc(), Agreement.id)
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    return list(rows), total


async def latest_pending(db: AsyncSession, agreement: Agreement, user: User) -> PendingTransaction | None:
    """The viewer's most recent unfinished (built / submitted) transaction for this agreement."""
    q = (
        select(PendingTransaction)
        .where(
            PendingTransaction.agreement_id == agreement.id,
            PendingTransaction.user_id == user.id,
            PendingTransaction.status.in_([PendingTxStatus.built, PendingTxStatus.submitted]),
        )
        .order_by(PendingTransaction.created_at.desc())
        .limit(1)
    )
    return (await db.execute(q)).scalar_one_or_none()


# --- action rules -------------------------------------------------------------------------------


def available_actions(agreement: Agreement, user: User | None, now: datetime | None = None) -> list[str]:
    """Which `POST /agreements/{id}/tx/{action}` calls the viewer may make right now."""
    role = party_role(agreement, user)
    st = agreement.status
    now = now or now_utc()
    if st is AgreementStatus.draft:
        if role is UserRole.customer:
            return ["open"]
        if role is UserRole.trader:
            return ["propose"]
        return []
    if st is AgreementStatus.proposed:
        if role is UserRole.customer:
            return ["fund"] + (["cancel"] if agreement.proposer_role is UserRole.customer else [])
        if role is UserRole.trader:
            return ["cancel"] if agreement.proposer_role is UserRole.trader else []
        return []
    if st is AgreementStatus.funded:
        if role is UserRole.trader:
            return ["accept", "cancel"]
        if role is UserRole.customer:
            return ["cancel"]
        return []
    if st is AgreementStatus.active:
        expired = is_expired(agreement, now)
        if role is UserRole.trader:
            return (["trade"] if not expired else []) + ["settle"]
        if role is UserRole.customer:
            return ["settle"]
        return ["settle"] if expired else []
    return []


def _require_status(agreement: Agreement, *allowed: AgreementStatus, action: str) -> None:
    if agreement.status not in allowed:
        raise StateError(
            f"cannot {action}: agreement is {agreement.status.value} (needs {' | '.join(s.value for s in allowed)})",
            code="invalid_state",
            details={"status": agreement.status.value, "action": action},
        )


def _require_role(role: UserRole | None, *allowed: UserRole, action: str) -> None:
    if role not in allowed:
        raise ForbiddenError(
            f"only the {' or '.join(r.value for r in allowed)} may {action} this agreement",
            code="wrong_party",
            details={"action": action},
        )


def _require_onchain(agreement: Agreement) -> int:
    if agreement.onchain_id is None:
        raise StateError("agreement is not on-chain yet", code="not_onchain")
    return int(agreement.onchain_id)


async def settle_min_outs(
    soroban: Any, agreement: Agreement, slippage_bps: int
) -> tuple[list[int], list[dict[str, Any]]]:
    """One `min_out` per non-base token in the on-chain `tokens` order (CONTRACT §3.3): router quote of the
    full balance back to base minus `slippage_bps`; 0 for empty balances (ignored by the contract)."""
    onchain_id = _require_onchain(agreement)
    chain = await soroban.get_agreement(onchain_id)
    balances = dict(await soroban.get_balances(onchain_id))
    base = chain.terms.base_token
    min_outs: list[int] = []
    legs: list[dict[str, Any]] = []
    for token in chain.tokens:
        if token == base:
            continue
        bal = int(balances.get(token, 0))
        quote = 0
        if bal > 0:
            try:
                quote = int(await soroban.router_quote(token, base, bal))
            except StellarError as e:  # no route: let the contract decide (RouterError), floor 0
                log.warning("settle quote %s -> %s failed: %s", token[:8], base[:8], e.message)
                quote = 0
        min_out = money.min_out_for_slippage(quote, slippage_bps) if quote > 0 else 0
        min_outs.append(min_out)
        legs.append({"token": token, "balance": bal, "quote": quote, "min_out": min_out})
    return min_outs, legs


async def record_pending(
    db: AsyncSession,
    user: User,
    kind: PendingTxKind,
    agreement: Agreement | None,
    unsigned: UnsignedTx,
    payload: dict[str, Any] | None = None,
) -> PendingTransaction:
    """Persist the unsigned envelope. `payload` (builder context: trade note / notify flag / settle legs) is
    stored under `payload["context"]`; the gateway summary keys stay at the top level. Older un-submitted
    rows of the same kind for the same agreement and user are marked `expired` (superseded)."""
    if agreement is not None:
        stale = (
            await db.execute(
                select(PendingTransaction).where(
                    PendingTransaction.agreement_id == agreement.id,
                    PendingTransaction.user_id == user.id,
                    PendingTransaction.kind == kind,
                    PendingTransaction.status == PendingTxStatus.built,
                )
            )
        ).scalars().all()
        for row in stale:
            row.status = PendingTxStatus.expired
            row.result = {"status": "EXPIRED", "reason": "superseded"}
    # gateway simulation summary (raw on-chain units) + builder context under `context` (no key clashes)
    data: dict[str, Any] = {"action": kind.value}
    data.update(json_safe(unsigned.summary))
    data["context"] = json_safe(payload or {})
    pending = PendingTransaction(
        user_id=user.id,
        kind=kind,
        agreement_id=agreement.id if agreement is not None else None,
        unsigned_xdr=unsigned.xdr,
        tx_hash=unsigned.hash or None,
        status=PendingTxStatus.built,
        payload=data,
        expires_at=unsigned.expires_at,
        created_at=now_utc(),
    )
    db.add(pending)
    await db.flush()
    return pending


def unsigned_out(pending: PendingTransaction, unsigned: UnsignedTx, source: str) -> UnsignedTxOut:
    """`summary` = the gateway's simulation summary merged with the builder context stored on the pending
    row (settle legs / slippage, trade note, ...), i.e. everything the app can show before signing."""
    return UnsignedTxOut(
        pending_tx_id=pending.id,
        kind=pending.kind,
        agreement_id=pending.agreement_id,
        unsigned_xdr=unsigned.xdr,
        network_passphrase=unsigned.network_passphrase,
        tx_hash=unsigned.hash,
        source=source,
        expires_at=unsigned.expires_at,
        summary=dict(pending.payload or {}) or json_safe(unsigned.summary),
    )


async def _listing_reservation(db: AsyncSession, agreement: Agreement) -> int | None:
    """Reservation id backing this agreement, when its capital listing still holds enough.

    A capital listing deposits its money into the vault up front, so the customer must not be asked
    to pay a second time: `open`/`fund` draw on that deposit instead of the wallet. Falls back to
    None (wallet path) for agreements with no listing, e.g. a direct offer from a chat.
    """
    from app.models import Listing  # local import: models package imports this module

    if agreement.listing_id is None or agreement.principal is None:
        return None
    listing = await db.get(Listing, agreement.listing_id)
    if listing is None or listing.reservation_id is None:
        return None
    if listing.reserved_amount is None or listing.reserved_amount < agreement.principal:
        return None
    return int(listing.reservation_id)


async def build_action_tx(
    db: AsyncSession,
    settings: Settings,
    soroban: Any,
    agreement: Agreement,
    user: User,
    action: str,
    *,
    slippage_bps: int | None = None,
) -> UnsignedTxOut:
    """`POST /agreements/{id}/tx/{action}` for action ∈ open|propose|fund|accept|cancel|settle."""
    if action not in ACTIONS:
        raise ValidationError(f"unknown action {action!r}", code="invalid_action", details={"allowed": list(ACTIONS)})
    role = party_role(agreement, user)
    addr = user.stellar_address
    payload: dict[str, Any] = {}
    if action == "open":
        _require_status(agreement, AgreementStatus.draft, action=action)
        _require_role(role, UserRole.customer, action=action)
        terms = build_terms(agreement)
        reservation_id = await _listing_reservation(db, agreement)
        if reservation_id is None:
            unsigned = await soroban.build_open(addr, terms)
        else:
            unsigned = await soroban.build_open_reserved(addr, terms, reservation_id)
            payload["reservation_id"] = reservation_id
    elif action == "propose":
        _require_status(agreement, AgreementStatus.draft, action=action)
        _require_role(role, UserRole.trader, action=action)
        terms = build_terms(agreement)
        unsigned = await soroban.build_propose(addr, terms)
    elif action == "fund":
        _require_status(agreement, AgreementStatus.proposed, action=action)
        _require_role(role, UserRole.customer, action=action)
        onchain_id = _require_onchain(agreement)
        reservation_id = await _listing_reservation(db, agreement)
        if reservation_id is None:
            unsigned = await soroban.build_fund(addr, onchain_id)
        else:
            unsigned = await soroban.build_fund_reserved(addr, onchain_id, reservation_id)
            payload["reservation_id"] = reservation_id
    elif action == "accept":
        _require_status(agreement, AgreementStatus.funded, action=action)
        _require_role(role, UserRole.trader, action=action)
        unsigned = await soroban.build_accept(addr, _require_onchain(agreement))
    elif action == "cancel":
        _require_status(agreement, AgreementStatus.proposed, AgreementStatus.funded, action=action)
        if agreement.status is AgreementStatus.proposed:
            _require_role(role, agreement.proposer_role, action=action)  # only the proposer (CONTRACT §3)
        else:
            _require_role(role, UserRole.customer, UserRole.trader, action=action)
        unsigned = await soroban.build_cancel(addr, _require_onchain(agreement))
    else:  # settle
        _require_status(agreement, AgreementStatus.active, action=action)
        onchain_id = _require_onchain(agreement)
        if role is None:
            # Contract tiers (CONTRACT.md §3.3): parties any time; the admin from end_time;
            # anyone else only from end_time + SETTLE_GRACE_SECS (7 days), no auth, in-contract floors.
            grace = timedelta(seconds=0) if getattr(user, "is_admin", False) else SETTLE_GRACE
            if agreement.end_time is None or now_utc() < agreement.end_time + grace:
                raise ForbiddenError(
                    "only the customer or the trader may settle before the end time"
                    + ("" if grace == timedelta(0) else " plus the 7-day grace period"),
                    code="not_expired",
                )
            min_outs: list[int] = []  # non-party after expiry: floors are computed in-contract
            payload["settle_mode"] = "permissionless"
        else:
            bps = settings.settle_slippage_bps if slippage_bps is None else int(slippage_bps)
            min_outs, legs = await settle_min_outs(soroban, agreement, bps)
            payload.update({"settle_mode": "party", "slippage_bps": bps, "legs": legs})
        unsigned = await soroban.build_settle(addr, onchain_id, min_outs)
    payload["role"] = role.value if role else None
    pending = await record_pending(db, user, PendingTxKind(action), agreement, unsigned, payload)
    log.info(
        "tx built action=%s agreement=%s onchain=%s user=%s pending=%s",
        action, agreement.id, agreement.onchain_id, user.id, pending.id,
    )
    return unsigned_out(pending, unsigned, addr)


# --- TL equivalents -------------------------------------------------------------------------------

_xlm_price_cache: tuple[Decimal, str, float] | None = None


def reset_price_cache() -> None:
    """Test hook."""
    global _xlm_price_cache
    _xlm_price_cache = None


async def xlm_usd_price(db: AsyncSession, settings: Settings, soroban: Any) -> tuple[Decimal, str] | None:
    """USD per XLM derived from the allow-listed router (Soroswap): quote 1 XLM -> a USDC token of the
    network. Best effort, cached 60 s; None when no route / RPC unavailable."""
    global _xlm_price_cache
    if _xlm_price_cache is not None and time.monotonic() - _xlm_price_cache[2] < XLM_PRICE_CACHE_SECONDS:
        return _xlm_price_cache[0], _xlm_price_cache[1]
    network = settings.stellar_network
    rows = (await db.execute(select(Asset).where(Asset.network == network, Asset.is_active.is_(True)))).scalars().all()
    xlm = next((a for a in rows if a.is_native), None)
    # Ağda aynı kodu taşıyan birden çok USDC olabiliyor (testnet'te ihraççılı
    # Circle USDC ve ihraççısız Soroswap test tokenı) ve havuzları birbirinden
    # kopuk: 1 XLM biri için 0.105, öbürü için 0.198 USDC. Hangisinin geldiği
    # sıraya kalırsa portföyün TL değeri iki katına kadar sapıyor. Bu yüzden
    # seçim belirgin: önce gerçek ihraççısı olan (anchor'ın bastığı) varlık,
    # sonra kontrat kimliğine göre sabit bir sıra.
    usdcs = sorted(
        (a for a in rows if a.code.upper() == "USDC"),
        key=lambda a: (a.issuer is None, a.contract_id),
    )
    if xlm is None or not usdcs or soroban is None:
        return None
    for usdc in usdcs:
        try:
            out = int(await soroban.router_quote(xlm.contract_id, usdc.contract_id, 10**xlm.decimals))
        except Exception as e:  # noqa: BLE001 - optional enrichment only
            log.debug("xlm price via %s unavailable: %s", usdc.contract_id[:8], e)
            continue
        if out > 0:
            price = money.from_stroops(out, usdc.decimals)
            source = f"soroswap:{usdc.contract_id[:8]}"
            _xlm_price_cache = (price, source, time.monotonic())
            return price, source
    return None


@dataclass
class TlConverter:
    """Per-request TL conversion context (USD/TRY rate + USD price per asset code)."""

    rate: fx.FxRate | None
    prices: dict[str, Decimal | None] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=dict)

    def usd_price(self, code: str) -> Decimal | None:
        return self.prices.get(code.upper())

    def to_try(self, amount: Decimal | None, code: str) -> Decimal | None:
        price = self.usd_price(code)
        if amount is None or price is None or self.rate is None:
            return None
        return fx.to_try(Decimal(amount) * price, self.rate)


async def tl_converter(db: AsyncSession, settings: Settings, soroban: Any, codes: set[str]) -> TlConverter | None:
    """Build a converter for `codes`; None when the FX rate is unavailable (TL fields are then null)."""
    try:
        rate = await fx.get_usd_try(settings, db)
    except Exception as e:  # noqa: BLE001 - never fail an agreement read because of FX
        log.warning("fx unavailable, TL equivalents disabled: %s", e)
        return None
    conv = TlConverter(rate=rate)
    for code in {c.upper() for c in codes}:
        price = fx.usd_price(code)
        source = "indicative"
        if price is None and code == "XLM":
            got = await xlm_usd_price(db, settings, soroban)
            if got is not None:
                price, source = got
        conv.prices[code] = price
        if price is not None:
            conv.sources[code] = source
    return conv


# --- serialisation ------------------------------------------------------------------------------


def party_out(user: User) -> PartyOut:
    return PartyOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        stellar_address=user.stellar_address,
        role=user.role,
    )


def asset_brief(asset: Asset) -> AssetBriefOut:
    return AssetBriefOut(
        id=asset.id,
        code=asset.code,
        contract_id=asset.contract_id,
        issuer=asset.issuer,
        decimals=asset.decimals,
        name=asset.name,
        icon_url=asset.icon_url,
        category=asset.category,
    )


def agreement_out(
    agreement: Agreement,
    user: User | None,
    *,
    tl: TlConverter | None = None,
    pending: PendingTransaction | None = None,
    now: datetime | None = None,
) -> AgreementOut:
    now = now or now_utc()
    base = agreement.base_asset
    value = agreement.current_value
    if agreement.status is AgreementStatus.settled and agreement.final_value is not None:
        value = agreement.final_value
    pnl = (Decimal(value) - agreement.principal) if value is not None else None
    floor = money.from_stroops(money.drawdown_floor(principal_raw(agreement), agreement.max_drawdown_bps), base.decimals)
    tl_out: TlOut | None = None
    if tl is not None and tl.rate is not None:
        code = base.code
        tl_out = TlOut(
            rate=tl.rate.rate,
            rate_source=tl.rate.source,
            stale=tl.rate.stale,
            base_usd_price=tl.usd_price(code),
            base_price_source=tl.sources.get(code.upper()),
            principal_try=tl.to_try(agreement.principal, code),
            current_value_try=tl.to_try(value, code),
            pnl_try=tl.to_try(pnl, code) if pnl is not None and tl.usd_price(code) is not None else None,
            final_value_try=tl.to_try(agreement.final_value, code),
            customer_payout_try=tl.to_try(agreement.customer_payout, code),
        )
    balances = [
        BalanceOut(
            asset=asset_brief(b.asset),
            balance=b.balance,
            updated_at=b.updated_at,
            value_try=tl.to_try(b.balance, b.asset.code) if tl is not None else None,
        )
        for b in agreement.balances
    ]
    remaining: int | None = None
    if agreement.end_time is not None:
        remaining = max(0, int((agreement.end_time - now).total_seconds()))
    return AgreementOut(
        id=agreement.id,
        onchain_id=agreement.onchain_id,
        offer_id=agreement.offer_id,
        listing_id=agreement.listing_id,
        status=agreement.status,
        proposer_role=agreement.proposer_role,
        customer=party_out(agreement.customer),
        trader=party_out(agreement.trader),
        base_asset=asset_brief(base),
        principal=agreement.principal,
        duration_secs=int(agreement.duration_secs),
        duration_days=int(agreement.duration_secs) // 86_400,
        commission_bps=agreement.commission_bps,
        max_drawdown_bps=agreement.max_drawdown_bps,
        risk_profile=agreement.risk_profile,
        listing_ref=agreement.listing_ref,
        created_tx=agreement.created_tx,
        activate_tx=agreement.activate_tx,
        cancel_tx=agreement.cancel_tx,
        settle_tx=agreement.settle_tx,
        start_time=agreement.start_time,
        end_time=agreement.end_time,
        seconds_remaining=remaining,
        is_expired=is_expired(agreement, now),
        current_value=agreement.current_value,
        value_updated_at=agreement.value_updated_at,
        high_water_value=agreement.high_water_value,
        pnl=pnl,
        pnl_bps=pnl_bps(value, agreement.principal),
        drawdown_floor=floor,
        drawdown_bps=drawdown_bps(value, agreement.principal),
        final_value=agreement.final_value,
        profit=agreement.profit,
        trader_fee=agreement.trader_fee,
        platform_fee=agreement.platform_fee,
        customer_payout=agreement.customer_payout,
        settled_at=agreement.settled_at,
        settled_by=agreement.settled_by,
        last_event_ledger=agreement.last_event_ledger,
        balances=balances,
        my_role=party_role(agreement, user),
        available_actions=available_actions(agreement, user, now),
        pending_tx=PendingTxBriefOut.model_validate(pending, from_attributes=True) if pending is not None else None,
        tl=tl_out,
        created_at=agreement.created_at,
        updated_at=agreement.updated_at,
    )


async def serialize_many(
    db: AsyncSession, settings: Settings, soroban: Any, rows: list[Agreement], user: User | None
) -> list[AgreementOut]:
    if not rows:
        return []
    codes = {ag.base_asset.code for ag in rows} | {b.asset.code for ag in rows for b in ag.balances}
    tl = await tl_converter(db, settings, soroban, codes)
    return [agreement_out(ag, user, tl=tl) for ag in rows]


async def serialize_one(
    db: AsyncSession, settings: Settings, soroban: Any, agreement: Agreement, user: User
) -> AgreementOut:
    codes = {agreement.base_asset.code} | {b.asset.code for b in agreement.balances}
    tl = await tl_converter(db, settings, soroban, codes)
    pending = await latest_pending(db, agreement, user)
    return agreement_out(agreement, user, tl=tl, pending=pending)


# --- trades / history ---------------------------------------------------------------------------


async def list_trades(db: AsyncSession, agreement: Agreement, *, limit: int = 20, offset: int = 0) -> tuple[list[Trade], int]:
    where = [Trade.agreement_id == agreement.id]
    total = int((await db.execute(select(func.count()).select_from(Trade).where(*where))).scalar_one())
    rows = (
        await db.execute(
            select(Trade).where(*where).order_by(Trade.created_at.desc(), Trade.id.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return list(rows), total


async def value_history(db: AsyncSession, agreement: Agreement, range_: ValueRange = "7d") -> ValueHistoryOut:
    """`agreement_value_snapshots` of the agreement (reconciler samples + event-time values), oldest first."""
    delta = _RANGE_DELTA[range_]
    where = [AgreementValueSnapshot.agreement_id == agreement.id]
    if delta is not None:
        where.append(AgreementValueSnapshot.at >= now_utc() - delta)
    rows = (
        await db.execute(
            select(AgreementValueSnapshot).where(*where).order_by(AgreementValueSnapshot.at.asc()).limit(2000)
        )
    ).scalars().all()
    principal = agreement.principal
    points = [ValuePointOut(at=r.at, value=r.value, return_bps=pnl_bps(r.value, principal) or 0) for r in rows]
    return ValueHistoryOut(
        agreement_id=agreement.id,
        range=range_,
        principal=principal,
        current_value=agreement.current_value,
        high_water_value=agreement.high_water_value,
        points=points,
    )


__all__ = [
    "ACTIONS",
    "CLOSED_STATUSES",
    "OPEN_STATUSES",
    "TlConverter",
    "agreement_out",
    "asset_brief",
    "available_actions",
    "build_action_tx",
    "build_terms",
    "compute_listing_ref",
    "drawdown_bps",
    "get_agreement_for",
    "get_agreement_row",
    "is_expired",
    "json_safe",
    "latest_pending",
    "list_agreements",
    "list_trades",
    "listing_ref_bytes",
    "now_utc",
    "parse_status_filter",
    "party_out",
    "party_role",
    "pnl_bps",
    "principal_raw",
    "record_pending",
    "serialize_many",
    "serialize_one",
    "settle_min_outs",
    "tl_converter",
    "ts_to_dt",
    "unsigned_out",
    "value_history",
    "xlm_usd_price",
]
