"""Vault event indexer + reconciler (DESIGN §2.2 `services/indexer.py`).

* `apply_event(ctx, record, decoded)` maps one decoded vault event onto the mirror rows (agreements,
  agreement_balances, trades, value snapshots, pending_transactions, notifications, trader stats). It is
  **idempotent** (guarded by tx hashes / (tx_hash, event index) / status) so the same event may arrive
  twice: once from `POST /tx/submit` (events parsed out of the transaction meta) and again from the
  `getEvents` poll.
* `run_indexer_once(db, soroban, settings)`: read the persisted cursor (`indexer_state.vault_events`),
  page through `getEvents` for the vault contract, apply, persist the cursor; also expires stale
  pending transactions and finalises submitted ones whose result the API did not see.
* `run_reconcile_once(db, soroban, settings)`: for every open agreement read `get_agreement`,
  `get_balances` and `value_in_base` -> current value, snapshots, high-water mark, drawdown alerts
  (80 % / 100 % of max drawdown), expiry reminders (24 h / 1 h) and the post-expiry "settle now" nudge.

Everything is flush-only; the worker / request session owns the commit.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import StellarError
from app.models import (
    Agreement,
    AgreementBalance,
    AgreementStatus,
    AgreementValueSnapshot,
    Asset,
    Follow,
    IndexerState,
    Listing,
    ListingStatus,
    Notification,
    NotificationCategory,
    PendingTransaction,
    PendingTxKind,
    PendingTxStatus,
    Trade,
    User,
    UserRole,
)
from app.services import amounts as money
from app.services.agreements import (
    OPEN_STATUSES,
    compute_listing_ref,
    json_safe,
    now_utc,
    ts_to_dt,
)
from app.services.notifications import notify, notify_many
from app.services.stellar import contract_abi as abi
from app.services.stellar.contract_abi import (
    ActivatedEvent,
    CancelledEvent,
    ReleasedEvent,
    ReservationDrawnEvent,
    ReservedEvent,
    OpenedEvent,
    ProposedEvent,
    SettledEvent,
    TokenSetEvent,
    TradedEvent,
    VaultContractError,
    VaultError,
)
from app.services.stellar.types import EventRecord, TxResult
from app.services.trading import symbol_label

log = logging.getLogger(__name__)

VAULT_EVENTS_KEY = "vault_events"  # same key app.services.admin reports as the indexer position
LOOKBACK_LEDGERS = 17_000  # ~1 day of ledgers: first-run fallback window (RPC retention is >= 24h)
EVENT_PAGE = 200
MAX_PAGES_PER_RUN = 20
SUBMITTED_STALE_SECONDS = 20  # re-poll submitted pending txs older than this
NOT_INCLUDED_GRACE = timedelta(minutes=10)  # submitted + expired + never found -> failed
MAX_FOLLOWER_NOTIFICATIONS = 500
DRAWDOWN_WARN_PCT = 80


@dataclass
class IndexerRunResult:
    skipped: bool = False
    reason: str | None = None
    events_seen: int = 0
    events_applied: int = 0
    cursor: str | None = None
    ledger: int | None = None
    latest_ledger: int | None = None
    pending_expired: int = 0
    pending_finalized: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return json_safe(self.__dict__)


@dataclass
class ReconcileResult:
    checked: int = 0
    valued: int = 0
    snapshots: int = 0
    alerts: int = 0
    status_synced: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return json_safe(self.__dict__)


class IndexContext:
    """Per-run caches around the session (assets by contract id, users by address, agreements by id)."""

    def __init__(self, db: AsyncSession, settings: Settings, soroban: Any) -> None:
        self.db = db
        self.settings = settings
        self.soroban = soroban
        self._assets: dict[str, Asset | None] = {}
        self._users: dict[str, User | None] = {}
        self._agreements: dict[int, Agreement] = {}

    @property
    def vault_id(self) -> str | None:
        v = getattr(self.soroban, "vault_contract_id", None)
        return v or self.settings.vault_contract_id

    async def asset_by_contract(self, contract_id: str) -> Asset | None:
        if contract_id not in self._assets:
            self._assets[contract_id] = (
                await self.db.execute(
                    select(Asset).where(Asset.network == self.settings.stellar_network, Asset.contract_id == contract_id)
                )
            ).scalar_one_or_none()
        return self._assets[contract_id]

    async def user_by_address(self, address: str) -> User | None:
        if address not in self._users:
            self._users[address] = (
                await self.db.execute(select(User).where(User.stellar_address == address))
            ).scalar_one_or_none()
        return self._users[address]

    async def agreement_by_onchain(self, onchain_id: int) -> Agreement | None:
        ag = self._agreements.get(int(onchain_id))
        if ag is None:
            ag = (await self.db.execute(select(Agreement).where(Agreement.onchain_id == int(onchain_id)))).scalar_one_or_none()
            if ag is not None:
                self._agreements[int(onchain_id)] = ag
        return ag

    def remember(self, ag: Agreement) -> None:
        if ag.onchain_id is not None:
            self._agreements[int(ag.onchain_id)] = ag

    async def pending_by_hash(self, tx_hash: str | None) -> PendingTransaction | None:
        if not tx_hash:
            return None
        return (
            await self.db.execute(
                select(PendingTransaction)
                .where(PendingTransaction.tx_hash == tx_hash)
                .order_by(PendingTransaction.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()


# --- helpers ------------------------------------------------------------------------------------


def _fmt(raw: int, asset: Asset) -> str:
    return money.format_amount(money.from_stroops(raw, asset.decimals), asset.decimals)


def _event_time(record: EventRecord) -> datetime:
    return record.ledger_close_at or now_utc()


def _decoded(record: EventRecord) -> Any:
    """Decoded vault event (re-decoded from XDR when the gateway did not)."""
    if record.decoded is not None:
        return record.decoded
    try:
        return abi.decode_event(record.topics_xdr, record.value_xdr)
    except StellarError as e:
        log.warning("undecodable event %s on %s: %s", record.id, record.contract_id[:8], e.message)
        return None


async def _upsert_balances(ctx: IndexContext, ag: Agreement, balances: list[tuple[str, int]]) -> None:
    """Mirror the on-chain `get_balances` vector (tokens with an unknown asset row are skipped)."""
    by_asset = {b.asset_id: b for b in ag.balances}
    keep: set[uuid.UUID] = set()
    for cid, raw in balances:
        asset = await ctx.asset_by_contract(cid)
        if asset is None:
            log.warning("agreement %s holds unknown token %s (not in assets)", ag.id, cid)
            continue
        value = money.from_stroops(int(raw), asset.decimals)
        row = by_asset.get(asset.id)
        if row is None:
            row = AgreementBalance(agreement_id=ag.id, asset_id=asset.id, balance=value, asset=asset)
            ag.balances.append(row)
        else:
            row.balance = value
        keep.add(asset.id)
    for row in list(ag.balances):
        if row.asset_id not in keep:
            ag.balances.remove(row)


async def _adjust_balance(ctx: IndexContext, ag: Agreement, cid: str, delta_raw: int) -> None:
    asset = await ctx.asset_by_contract(cid)
    if asset is None:
        return
    delta = money.from_stroops(delta_raw, asset.decimals)
    row = next((b for b in ag.balances if b.asset_id == asset.id), None)
    if row is None:
        if delta <= 0:
            return
        ag.balances.append(AgreementBalance(agreement_id=ag.id, asset_id=asset.id, balance=delta, asset=asset))
        return
    row.balance = row.balance + delta
    if row.balance <= 0 and asset.contract_id != ag.base_asset.contract_id:
        ag.balances.remove(row)


def _clear_balances(ag: Agreement) -> None:
    for row in list(ag.balances):
        ag.balances.remove(row)


def _set_value(ag: Agreement, value: Decimal, at: datetime) -> None:
    ag.current_value = value
    ag.value_updated_at = at
    if ag.high_water_value is None or value > ag.high_water_value:
        ag.high_water_value = value


def _snapshot(ctx: IndexContext, ag: Agreement, value: Decimal, at: datetime) -> None:
    ctx.db.add(AgreementValueSnapshot(agreement_id=ag.id, value=value, at=at))


async def _mark_pending(ctx: IndexContext, record: EventRecord, ev: Any, *, kind: PendingTxKind | None = None) -> PendingTransaction | None:
    pending = await ctx.pending_by_hash(record.tx_hash)
    if pending is None:
        return None
    if kind is not None and pending.kind is not kind:
        return pending
    if pending.status is not PendingTxStatus.success:
        pending.status = PendingTxStatus.success
        result = dict(pending.result or {})
        result.update({"status": "SUCCESS", "ledger": record.ledger, "event": json_safe(ev.as_dict())})
        pending.result = result
        if pending.submitted_at is None:
            pending.submitted_at = _event_time(record)
    return pending


async def _notify_parties(
    ctx: IndexContext,
    ag: Agreement,
    type_: str,
    title: str,
    body: str,
    data: dict[str, Any] | None = None,
    *,
    exclude: uuid.UUID | None = None,
    only: UserRole | None = None,
) -> int:
    payload = {"agreement_id": str(ag.id), "onchain_id": ag.onchain_id, **(data or {})}
    targets = []
    if only in (None, UserRole.customer):
        targets.append(ag.customer_id)
    if only in (None, UserRole.trader):
        targets.append(ag.trader_id)
    n = 0
    for uid in targets:
        if uid == exclude:
            continue
        await notify(ctx.db, uid, type_, title, body, payload, category=NotificationCategory.agreement)
        n += 1
    return n


async def _already_notified(db: AsyncSession, user_id: uuid.UUID, type_: str, agreement_id: uuid.UUID) -> bool:
    q = select(Notification.id).where(
        Notification.user_id == user_id,
        Notification.type == type_,
        Notification.data["agreement_id"].astext == str(agreement_id),
    ).limit(1)
    return (await db.execute(q)).scalar_one_or_none() is not None


# --- agreement discovery ------------------------------------------------------------------------


async def _chain_agreement(ctx: IndexContext, onchain_id: int) -> abi.Agreement | None:
    try:
        return await ctx.soroban.get_agreement(int(onchain_id))
    except VaultContractError as e:
        if e.error is VaultError.NotFound:
            return None
        raise
    except StellarError as e:
        log.warning("get_agreement(%s) failed: %s", onchain_id, e.message)
        return None


async def _match_draft(
    ctx: IndexContext, *, listing_ref: str | None, customer: str, trader: str, principal_raw: int, base_token: str
) -> Agreement | None:
    """A draft row for these terms: by listing_ref first, then by parties + principal + base token."""
    base = await ctx.asset_by_contract(base_token)
    cust = await ctx.user_by_address(customer)
    trd = await ctx.user_by_address(trader)
    if listing_ref:
        rows = (
            await ctx.db.execute(
                select(Agreement)
                .where(Agreement.listing_ref == listing_ref, Agreement.onchain_id.is_(None))
                .order_by(Agreement.created_at.asc())
            )
        ).scalars().all()
        for ag in rows:
            if cust is None or trd is None or (ag.customer_id == cust.id and ag.trader_id == trd.id):
                return ag
    if cust is None or trd is None or base is None:
        return None
    principal = money.from_stroops(principal_raw, base.decimals)
    return (
        await ctx.db.execute(
            select(Agreement)
            .where(
                Agreement.onchain_id.is_(None),
                Agreement.status == AgreementStatus.draft,
                Agreement.customer_id == cust.id,
                Agreement.trader_id == trd.id,
                Agreement.base_asset_id == base.id,
                Agreement.principal == principal,
            )
            .order_by(Agreement.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def _create_from_chain(ctx: IndexContext, chain: abi.Agreement) -> Agreement | None:
    """Mirror row for an agreement created outside the app flow (both parties must be registered)."""
    t = chain.terms
    cust = await ctx.user_by_address(t.customer)
    trd = await ctx.user_by_address(t.trader)
    base = await ctx.asset_by_contract(t.base_token)
    if cust is None or trd is None or base is None:
        log.warning(
            "cannot mirror on-chain agreement %s: unknown customer/trader/base (%s/%s/%s)",
            chain.id, cust is not None, trd is not None, base is not None,
        )
        return None
    ag = Agreement(
        onchain_id=int(chain.id),
        customer_id=cust.id,
        trader_id=trd.id,
        base_asset_id=base.id,
        principal=money.from_stroops(t.principal, base.decimals),
        duration_secs=int(t.duration_secs),
        commission_bps=int(t.commission_bps),
        max_drawdown_bps=int(t.max_drawdown_bps),
        listing_ref=t.listing_ref_hex,
        status=AgreementStatus.from_onchain(int(chain.status)),
        proposer_role=UserRole.trader if chain.proposer == t.trader else UserRole.customer,
        start_time=ts_to_dt(chain.start_time),
        end_time=ts_to_dt(chain.end_time),
        customer=cust,
        trader=trd,
        base_asset=base,
    )
    ctx.db.add(ag)
    await ctx.db.flush()
    await ctx.db.refresh(ag)
    ctx.remember(ag)
    log.info("mirrored on-chain agreement %s as %s", chain.id, ag.id)
    return ag


async def _resolve_agreement(ctx: IndexContext, record: EventRecord, onchain_id: int, ev: Any = None) -> Agreement | None:
    """Row for `onchain_id`: existing mirror -> pending tx of this hash -> draft matched via chain terms /
    event fields -> new row mirrored from the chain."""
    ag = await ctx.agreement_by_onchain(onchain_id)
    if ag is not None:
        return ag
    pending = await ctx.pending_by_hash(record.tx_hash)
    if pending is not None and pending.agreement_id is not None and pending.kind in (PendingTxKind.open, PendingTxKind.propose):
        ag = await ctx.db.get(Agreement, pending.agreement_id)
        if ag is not None and ag.onchain_id in (None, int(onchain_id)):
            return ag
    chain = await _chain_agreement(ctx, onchain_id)
    if chain is not None:
        t = chain.terms
        ag = await _match_draft(
            ctx, listing_ref=t.listing_ref_hex, customer=t.customer, trader=t.trader, principal_raw=t.principal, base_token=t.base_token
        )
        if ag is not None:
            return ag
        return await _create_from_chain(ctx, chain)
    if isinstance(ev, ProposedEvent | OpenedEvent):
        return await _match_draft(
            ctx, listing_ref=None, customer=ev.customer, trader=ev.trader, principal_raw=ev.principal, base_token=ev.base_token
        )
    return None


# --- event handlers -----------------------------------------------------------------------------


async def _on_created(ctx: IndexContext, record: EventRecord, ev: ProposedEvent | OpenedEvent, *, actor: uuid.UUID | None) -> bool:
    opened = isinstance(ev, OpenedEvent)
    ag = await _resolve_agreement(ctx, record, ev.id, ev)
    if ag is None:
        log.warning("%s event for unknown agreement %s (tx %s) — skipped", ev.NAME, ev.id, record.tx_hash[:8])
        return False
    if ag.onchain_id is not None and int(ag.onchain_id) != int(ev.id):
        log.warning("agreement %s already bound to onchain %s, event says %s", ag.id, ag.onchain_id, ev.id)
        return False
    await _mark_pending(ctx, record, ev)
    if ag.onchain_id == int(ev.id) and ag.created_tx == record.tx_hash:
        return False  # already applied
    ag.onchain_id = int(ev.id)
    ctx.remember(ag)
    if ag.status in (AgreementStatus.draft, AgreementStatus.proposed, AgreementStatus.funded, AgreementStatus.failed):
        ag.status = AgreementStatus.funded if opened else AgreementStatus.proposed
    ag.proposer_role = UserRole.customer if opened else UserRole.trader
    ag.created_tx = record.tx_hash
    ag.last_event_ledger = record.ledger
    if not ag.listing_ref or len(ag.listing_ref) != 64:
        ag.listing_ref = compute_listing_ref(ag.offer_id or ag.id)
    if opened:
        await _upsert_balances(ctx, ag, [(ev.base_token, ev.principal)])
    await ctx.db.flush()
    base = ag.base_asset
    amount = f"{money.format_amount(ag.principal, base.decimals)} {base.code}"
    if opened:
        await _notify_parties(
            ctx, ag, "agreement_funded", "Escrow funded",
            f"{ag.customer.display_name} locked {amount}. Accept to start the agreement.",
            {"tx_hash": record.tx_hash}, exclude=actor, only=UserRole.trader,
        )
    else:
        await _notify_parties(
            ctx, ag, "agreement_proposed", "New agreement proposal",
            f"{ag.trader.display_name} proposed an agreement for {amount}. Fund it to start.",
            {"tx_hash": record.tx_hash}, exclude=actor, only=UserRole.customer,
        )
    return True


async def _on_activated(ctx: IndexContext, record: EventRecord, ev: ActivatedEvent, *, actor: uuid.UUID | None) -> bool:
    ag = await _resolve_agreement(ctx, record, ev.id, ev)
    if ag is None:
        log.warning("activated event for unknown agreement %s — skipped", ev.id)
        return False
    await _mark_pending(ctx, record, ev)
    if ag.activate_tx == record.tx_hash:
        return False  # already applied (a tx activates at most once)
    if ag.onchain_id is None:
        ag.onchain_id = int(ev.id)
        ctx.remember(ag)
    if ag.status not in (AgreementStatus.settled, AgreementStatus.cancelled):
        ag.status = AgreementStatus.active
    ag.start_time = ts_to_dt(ev.start_time)
    ag.end_time = ts_to_dt(ev.end_time)
    ag.activate_tx = record.tx_hash
    ag.last_event_ledger = record.ledger
    if not ag.balances:
        await _upsert_balances(ctx, ag, [(ag.base_asset.contract_id, money.to_stroops(ag.principal, ag.base_asset.decimals))])
    at = _event_time(record)
    if ag.current_value is None:
        _set_value(ag, ag.principal, at)
        _snapshot(ctx, ag, ag.principal, at)
    await ctx.db.flush()
    await refresh_trader_stats(ctx.db, ag.trader_id)
    end = ag.end_time.strftime("%d.%m.%Y %H:%M") if ag.end_time else "-"
    await _notify_parties(
        ctx, ag, "agreement_activated", "Agreement active",
        f"Started with {money.format_amount(ag.principal, ag.base_asset.decimals)} {ag.base_asset.code}. Ends {end}.",
        {"tx_hash": record.tx_hash, "end_time": ag.end_time.isoformat() if ag.end_time else None}, exclude=actor,
    )
    return True


async def _on_cancelled(ctx: IndexContext, record: EventRecord, ev: CancelledEvent, *, actor: uuid.UUID | None) -> bool:
    ag = await _resolve_agreement(ctx, record, ev.id, ev)
    if ag is None:
        log.warning("cancelled event for unknown agreement %s — skipped", ev.id)
        return False
    await _mark_pending(ctx, record, ev)
    if ag.cancel_tx == record.tx_hash:
        return False
    ag.status = AgreementStatus.cancelled
    ag.cancel_tx = record.tx_hash
    ag.last_event_ledger = record.ledger
    _clear_balances(ag)
    await ctx.db.flush()
    await refresh_trader_stats(ctx.db, ag.trader_id)
    base = ag.base_asset
    refund = _fmt(ev.refunded, base)
    body = f"The agreement was cancelled. Refunded: {refund} {base.code}." if ev.refunded > 0 else "The agreement was cancelled."
    await _notify_parties(ctx, ag, "agreement_cancelled", "Agreement cancelled", body, {"tx_hash": record.tx_hash, "refunded": refund}, exclude=actor)
    return True


async def _on_traded(ctx: IndexContext, record: EventRecord, ev: TradedEvent, *, actor: uuid.UUID | None) -> bool:
    ag = await _resolve_agreement(ctx, record, ev.id, ev)
    if ag is None:
        log.warning("traded event for unknown agreement %s — skipped", ev.id)
        return False
    pending = await _mark_pending(ctx, record, ev, kind=PendingTxKind.trade)
    existing = (
        await ctx.db.execute(
            select(Trade.id).where(Trade.tx_hash == record.tx_hash, Trade.onchain_seq == int(record.event_index))
        )
    ).scalar_one_or_none()
    if existing is not None:
        return False
    a_in = await ctx.asset_by_contract(ev.token_in)
    a_out = await ctx.asset_by_contract(ev.token_out)
    if a_in is None or a_out is None:
        log.warning("traded event %s uses unknown tokens (%s -> %s) — skipped", record.id, ev.token_in[:8], ev.token_out[:8])
        return False
    payload = dict((pending.payload or {}).get("context") or {}) if pending is not None and pending.kind is PendingTxKind.trade else {}
    at = _event_time(record)
    base = ag.base_asset
    value_after = money.from_stroops(ev.value_after, base.decimals)
    trade = Trade(
        agreement_id=ag.id,
        onchain_seq=int(record.event_index),
        tx_hash=record.tx_hash,
        ledger=record.ledger,
        trader_id=ag.trader_id,
        token_in_id=a_in.id,
        token_out_id=a_out.id,
        amount_in=money.from_stroops(ev.amount_in, a_in.decimals),
        amount_out=money.from_stroops(ev.amount_out, a_out.decimals),
        value_after=value_after,
        note=payload.get("note"),
        symbol_label=payload.get("symbol_label") or symbol_label(a_in, a_out, base),
        notify_investors=bool(payload.get("notify_investors", True)),
        created_at=at,
        token_in=a_in,
        token_out=a_out,
    )
    ctx.db.add(trade)
    if ag.onchain_id is not None:
        try:
            await _upsert_balances(ctx, ag, await ctx.soroban.get_balances(int(ag.onchain_id)))
        except StellarError as e:  # chain unreachable: keep the mirror consistent arithmetically
            log.warning("get_balances(%s) failed after trade, adjusting locally: %s", ag.onchain_id, e.message)
            await _adjust_balance(ctx, ag, ev.token_in, -ev.amount_in)
            await _adjust_balance(ctx, ag, ev.token_out, ev.amount_out)
    _set_value(ag, value_after, at)
    _snapshot(ctx, ag, value_after, at)
    ag.last_event_ledger = record.ledger
    await ctx.db.flush()
    label = trade.symbol_label or f"{a_in.code}/{a_out.code}"
    body = f"{label}: {_fmt(ev.amount_in, a_in)} {a_in.code} → {_fmt(ev.amount_out, a_out)} {a_out.code}"
    if trade.note:
        body += f" — {trade.note[:120]}"
    data = {"trade_id": str(trade.id), "tx_hash": record.tx_hash, "value_after": str(value_after)}
    await _notify_parties(ctx, ag, "trade_executed", "New trade", body, data, exclude=actor, only=UserRole.customer)
    if trade.notify_investors:
        followers = (
            await ctx.db.execute(
                select(Follow.follower_id).where(Follow.trader_id == ag.trader_id).limit(MAX_FOLLOWER_NOTIFICATIONS)
            )
        ).scalars().all()
        targets = [f for f in followers if f not in (ag.customer_id, ag.trader_id, actor)]
        if targets:
            await notify_many(
                ctx.db, list(targets), "followed_trade", f"{ag.trader.display_name} opened a trade", body,
                {"agreement_id": str(ag.id), "trader_id": str(ag.trader_id), **data}, category=NotificationCategory.agreement,
            )
    return True


async def _on_settled(ctx: IndexContext, record: EventRecord, ev: SettledEvent, *, actor: uuid.UUID | None) -> bool:
    ag = await _resolve_agreement(ctx, record, ev.id, ev)
    if ag is None:
        log.warning("settled event for unknown agreement %s — skipped", ev.id)
        return False
    await _mark_pending(ctx, record, ev)
    if ag.settle_tx == record.tx_hash:
        return False
    base = ag.base_asset
    at = _event_time(record)
    ag.status = AgreementStatus.settled
    ag.settle_tx = record.tx_hash
    ag.final_value = money.from_stroops(ev.final_value, base.decimals)
    ag.profit = money.from_stroops(ev.profit, base.decimals)
    ag.trader_fee = money.from_stroops(ev.trader_fee, base.decimals)
    ag.platform_fee = money.from_stroops(ev.platform_fee, base.decimals)
    ag.customer_payout = money.from_stroops(ev.customer_payout, base.decimals)
    ag.settled_at = at
    ag.settled_by = ev.by
    ag.last_event_ledger = record.ledger
    _set_value(ag, ag.final_value, at)
    _snapshot(ctx, ag, ag.final_value, at)
    _clear_balances(ag)
    await ctx.db.flush()
    await refresh_trader_stats(ctx.db, ag.trader_id)
    pnl = ag.final_value - ag.principal
    sign = "+" if pnl >= 0 else ""
    body = (
        f"Final value {_fmt(ev.final_value, base)} {base.code} ({sign}{money.format_amount(pnl, base.decimals)}). "
        f"Customer: {_fmt(ev.customer_payout, base)}, trader commission: {_fmt(ev.trader_fee, base)} {base.code}."
    )
    data = {"tx_hash": record.tx_hash, "final_value": str(ag.final_value), "profit": str(ag.profit), "by": ev.by}
    await _notify_parties(ctx, ag, "agreement_settled", "Agreement settled", body, data, exclude=actor)
    return True


async def _on_token_set(ctx: IndexContext, record: EventRecord, ev: TokenSetEvent) -> bool:
    asset = await ctx.asset_by_contract(ev.token)
    if asset is None or asset.onchain_allowed == bool(ev.allowed):
        return False
    asset.onchain_allowed = bool(ev.allowed)
    await ctx.db.flush()
    return True


async def _listing_by_reservation(ctx: IndexContext, reservation_id: int) -> Listing | None:
    return (
        await ctx.db.execute(select(Listing).where(Listing.reservation_id == int(reservation_id)))
    ).scalars().first()


async def _listing_for_reserved(ctx: IndexContext, ev: ReservedEvent) -> Listing | None:
    """The draft listing this `reserve` was signed for.

    `listing_ref` is the sha256 of the listing id, so it identifies the row without trusting the
    client; the pending row is only a fallback for events whose ref we cannot match (older builds).
    """
    ref = ev.listing_ref.hex()
    owner = await ctx.user_by_address(ev.customer)
    q = select(Listing).where(Listing.reservation_id.is_(None))
    if owner is not None:
        q = q.where(Listing.owner_id == owner.id)
    for row in (await ctx.db.execute(q)).scalars().all():
        if compute_listing_ref(row.id) == ref:
            return row
    return None


async def _on_reserved(ctx: IndexContext, record: EventRecord, ev: ReservedEvent) -> bool:
    """Capital is now locked in the vault: the draft listing goes public."""
    if await _listing_by_reservation(ctx, ev.id) is not None:
        return False  # already applied
    listing = await _listing_for_reserved(ctx, ev)
    if listing is None:
        log.info("reserved event %s has no matching listing (ref=%s)", ev.id, ev.listing_ref.hex()[:12])
        return False
    asset = await ctx.asset_by_contract(ev.token)
    listing.reservation_id = int(ev.id)
    listing.reserved_amount = money.from_stroops(int(ev.amount), asset.decimals if asset else 7)
    listing.reserve_tx = record.tx_hash
    if listing.status is ListingStatus.draft:
        listing.status = ListingStatus.active
    await ctx.db.flush()
    return True


async def _on_released(ctx: IndexContext, record: EventRecord, ev: ReleasedEvent) -> bool:
    listing = await _listing_by_reservation(ctx, ev.id)
    if listing is None:
        return False
    asset = await ctx.asset_by_contract(ev.token)
    remaining = money.from_stroops(int(ev.remaining), asset.decimals if asset else 7)
    if listing.reserved_amount == remaining and listing.release_tx == record.tx_hash:
        return False
    listing.reserved_amount = remaining
    listing.release_tx = record.tx_hash
    await ctx.db.flush()
    return True


async def _on_reservation_drawn(ctx: IndexContext, record: EventRecord, ev: ReservationDrawnEvent) -> bool:
    """An agreement took its principal out of the reservation."""
    listing = await _listing_by_reservation(ctx, ev.id)
    if listing is None:
        return False
    asset = await ctx.db.get(Asset, listing.base_asset_id) if listing.base_asset_id else None
    remaining = money.from_stroops(int(ev.remaining), asset.decimals if asset else 7)
    if listing.reserved_amount == remaining:
        return False
    listing.reserved_amount = remaining
    await ctx.db.flush()
    return True


async def apply_event(ctx: IndexContext, record: EventRecord, decoded: Any = None, *, actor_user_id: uuid.UUID | None = None) -> bool:
    """Apply one vault event; returns True when it changed something (False = already applied / ignored)."""
    ev = decoded if decoded is not None else _decoded(record)
    if ev is None:
        return False
    if isinstance(ev, ProposedEvent | OpenedEvent):
        return await _on_created(ctx, record, ev, actor=actor_user_id)
    if isinstance(ev, ActivatedEvent):
        return await _on_activated(ctx, record, ev, actor=actor_user_id)
    if isinstance(ev, CancelledEvent):
        return await _on_cancelled(ctx, record, ev, actor=actor_user_id)
    if isinstance(ev, TradedEvent):
        return await _on_traded(ctx, record, ev, actor=actor_user_id)
    if isinstance(ev, SettledEvent):
        return await _on_settled(ctx, record, ev, actor=actor_user_id)
    if isinstance(ev, TokenSetEvent):
        return await _on_token_set(ctx, record, ev)
    if isinstance(ev, ReservedEvent):
        return await _on_reserved(ctx, record, ev)
    if isinstance(ev, ReleasedEvent):
        return await _on_released(ctx, record, ev)
    if isinstance(ev, ReservationDrawnEvent):
        return await _on_reservation_drawn(ctx, record, ev)
    log.info("vault event %s ignored (%s)", getattr(ev, "NAME", type(ev).__name__), record.id)
    return False


# --- transaction results (POST /tx/submit and late finalisation) --------------------------------


async def _optimistic_by_kind(ctx: IndexContext, pending: PendingTransaction, res: TxResult) -> None:
    """Fallback when a successful transaction carried no decodable vault events (should not happen with
    the real RPC meta): move the mirror forward from the pending row's kind alone."""
    if pending.agreement_id is None:
        return
    ag = await ctx.db.get(Agreement, pending.agreement_id)
    if ag is None:
        return
    now = now_utc()
    kind = pending.kind
    if kind in (PendingTxKind.open, PendingTxKind.propose):
        rv = res.return_value
        if isinstance(rv, int) and ag.onchain_id is None:
            ag.onchain_id = int(rv)
        if ag.status is AgreementStatus.draft:
            ag.status = AgreementStatus.funded if kind is PendingTxKind.open else AgreementStatus.proposed
        ag.created_tx = res.hash
    elif kind in (PendingTxKind.fund, PendingTxKind.accept):
        if ag.status in (AgreementStatus.proposed, AgreementStatus.funded):
            ag.status = AgreementStatus.active
            ag.start_time = now
            ag.end_time = now + timedelta(seconds=int(ag.duration_secs))
        ag.activate_tx = res.hash
    elif kind is PendingTxKind.cancel:
        if ag.status in (AgreementStatus.proposed, AgreementStatus.funded):
            ag.status = AgreementStatus.cancelled
        ag.cancel_tx = res.hash
    elif kind is PendingTxKind.settle:
        if ag.status is AgreementStatus.active:
            ag.status = AgreementStatus.settled
            ag.settled_at = now
        ag.settle_tx = res.hash
    if res.ledger:
        ag.last_event_ledger = res.ledger
    await ctx.db.flush()


async def apply_tx_result(
    ctx: IndexContext, pending: PendingTransaction, res: TxResult, *, actor_user_id: uuid.UUID | None = None
) -> dict[str, Any]:
    """Record a polled `getTransaction` outcome on the pending row and apply its vault events."""
    pending.tx_hash = pending.tx_hash or res.hash
    events: list[dict[str, Any]] = []
    applied = 0
    if res.ok:
        vault = ctx.vault_id
        for rec in res.events:
            if vault and rec.contract_id and rec.contract_id != vault:
                continue
            ev = _decoded(rec)
            if ev is None:
                continue
            events.append(json_safe(ev.as_dict()))
            if await apply_event(ctx, rec, ev, actor_user_id=actor_user_id):
                applied += 1
        if not events:
            await _optimistic_by_kind(ctx, pending, res)
        pending.status = PendingTxStatus.success
        pending.result = json_safe(
            {"status": "SUCCESS", "ledger": res.ledger, "return_value": res.return_value, "events": events, "applied": applied}
        )
    elif res.status == "FAILED":
        err = abi.VaultError.from_code(res.contract_error_code)
        pending.status = PendingTxStatus.failed
        pending.result = json_safe(
            {
                "status": "FAILED",
                "ledger": res.ledger,
                "error": res.error,
                "contract_error_code": res.contract_error_code,
                "contract_error": err.name if err else None,
            }
        )
        if pending.agreement_id is not None:
            reason = abi.ERROR_MESSAGES.get(err, res.error or "the transaction failed") if err else (res.error or "the transaction failed")
            await notify(
                ctx.db, pending.user_id, "tx_failed", "Transaction failed",
                f"The network rejected your {pending.kind.value} transaction: {reason}",
                {"agreement_id": str(pending.agreement_id), "pending_tx_id": str(pending.id), "tx_hash": res.hash},
                category=NotificationCategory.agreement,
            )
    else:
        pending.result = json_safe({"status": "PENDING", "checked_at": now_utc()})
    if pending.submitted_at is None:
        pending.submitted_at = now_utc()
    await ctx.db.flush()
    return {"applied": applied, "events": events}


async def expire_pending(ctx: IndexContext, *, limit: int = 200) -> int:
    """`built` rows whose envelope time bound passed -> `expired`."""
    now = now_utc()
    rows = (
        await ctx.db.execute(
            select(PendingTransaction)
            .where(PendingTransaction.status == PendingTxStatus.built, PendingTransaction.expires_at <= now)
            .limit(limit)
        )
    ).scalars().all()
    for row in rows:
        row.status = PendingTxStatus.expired
        row.result = {"status": "EXPIRED", "reason": "not_signed_in_time"}
    if rows:
        await ctx.db.flush()
    return len(rows)


async def finalize_submitted(ctx: IndexContext, *, limit: int = 25) -> int:
    """Re-poll `submitted` rows the API did not see through (client disconnected, RPC slow)."""
    now = now_utc()
    rows = (
        await ctx.db.execute(
            select(PendingTransaction)
            .where(
                PendingTransaction.status == PendingTxStatus.submitted,
                PendingTransaction.tx_hash.is_not(None),
                PendingTransaction.submitted_at <= now - timedelta(seconds=SUBMITTED_STALE_SECONDS),
            )
            .order_by(PendingTransaction.submitted_at.asc())
            .limit(limit)
        )
    ).scalars().all()
    done = 0
    for row in rows:
        try:
            res = await ctx.soroban.get_transaction(row.tx_hash)
        except StellarError as e:
            log.warning("finalize %s: %s", row.tx_hash[:8], e.message)
            continue
        if res.pending:
            if row.expires_at + NOT_INCLUDED_GRACE <= now:
                row.status = PendingTxStatus.failed
                row.result = {"status": "FAILED", "error": "not_included", "detail": "transaction expired before inclusion"}
                done += 1
            continue
        await apply_tx_result(ctx, row, res, actor_user_id=row.user_id)
        done += 1
    return done


# --- indexer loop -------------------------------------------------------------------------------


async def _state(db: AsyncSession, key: str) -> IndexerState:
    row = await db.get(IndexerState, key)
    if row is None:
        row = IndexerState(key=key)
        db.add(row)
        await db.flush()
    return row


async def run_indexer_once(db: AsyncSession, soroban: Any, settings: Settings) -> IndexerRunResult:
    """One indexer tick (worker: every `settings.indexer_poll_seconds`). Flush only."""
    ctx = IndexContext(db, settings, soroban)
    out = IndexerRunResult()
    vault = ctx.vault_id
    if not vault:
        out.skipped, out.reason = True, "vault_contract_id not configured"
        return out
    state = await _state(db, VAULT_EVENTS_KEY)
    cursor = state.cursor
    start_ledger: int | None = None
    if not cursor:
        latest = await soroban.latest_ledger()
        start_ledger = (state.ledger + 1) if state.ledger else max(1, latest - LOOKBACK_LEDGERS)
    for _ in range(MAX_PAGES_PER_RUN):
        try:
            events, next_cursor, latest = await soroban.get_events(
                start_ledger=start_ledger if not cursor else None, cursor=cursor, contract_id=vault, limit=EVENT_PAGE
            )
        except StellarError as e:
            if cursor or start_ledger is None:
                raise
            # start ledger outside the RPC retention window: fall back to the recent past
            latest = await soroban.latest_ledger()
            out.errors.append(f"get_events from {start_ledger}: {e.message}; retrying from {max(1, latest - 100)}")
            start_ledger = max(1, latest - 100)
            events, next_cursor, latest = await soroban.get_events(start_ledger=start_ledger, contract_id=vault, limit=EVENT_PAGE)
        out.latest_ledger = int(latest)
        for rec in events:
            out.events_seen += 1
            if rec.contract_id and rec.contract_id != vault:
                continue
            try:
                async with db.begin_nested():
                    if await apply_event(ctx, rec):
                        out.events_applied += 1
            except Exception as e:  # noqa: BLE001 - one bad event must not stall the cursor
                log.exception("indexer: event %s failed", rec.id)
                out.errors.append(f"{rec.id}: {type(e).__name__}: {str(e)[:160]}")
            state.ledger = max(int(state.ledger or 0), int(rec.ledger))
        if not events or not next_cursor or next_cursor == cursor:
            if not events and state.ledger is None:
                state.ledger = int(latest)
            break
        cursor = next_cursor
        state.cursor = cursor
        if len(events) < EVENT_PAGE:
            break
    if cursor:
        state.cursor = cursor
    state.updated_at = now_utc()
    out.cursor, out.ledger = state.cursor, state.ledger
    out.pending_expired = await expire_pending(ctx)
    try:
        out.pending_finalized = await finalize_submitted(ctx)
    except Exception as e:  # noqa: BLE001
        log.exception("indexer: finalize_submitted failed")
        out.errors.append(f"finalize: {type(e).__name__}: {str(e)[:160]}")
    await db.flush()
    if out.events_seen or out.errors:
        log.info("indexer: %s", out.as_dict())
    return out


# --- reconciler ---------------------------------------------------------------------------------


async def _alert_once(ctx: IndexContext, ag: Agreement, type_: str, title: str, body: str, data: dict[str, Any]) -> int:
    n = 0
    for uid in (ag.customer_id, ag.trader_id):
        if await _already_notified(ctx.db, uid, type_, ag.id):
            continue
        await notify(ctx.db, uid, type_, title, body, {"agreement_id": str(ag.id), "onchain_id": ag.onchain_id, **data}, category=NotificationCategory.agreement)
        n += 1
    return n


async def check_alerts(ctx: IndexContext, ag: Agreement, value: Decimal, now: datetime | None = None) -> int:
    """Drawdown (80 % / 100 % of max_drawdown) and expiry (24 h / 1 h / overdue) notifications, once each."""
    now = now or now_utc()
    alerts = 0
    base = ag.base_asset
    if ag.max_drawdown_bps < money.BPS_DENOM and value < ag.principal:
        dd_bps = int((ag.principal - value) * money.BPS_DENOM / ag.principal)
        pct = money.format_amount(Decimal(dd_bps) / 100, 2)
        data = {"drawdown_bps": dd_bps, "max_drawdown_bps": ag.max_drawdown_bps, "value": str(value)}
        if dd_bps >= ag.max_drawdown_bps:
            alerts += await _alert_once(
                ctx, ag, "drawdown_100", "Max-loss limit reached",
                f"The portfolio is down {pct}% (limit {ag.max_drawdown_bps / 100:g}%). The contract now rejects new trades.", data,
            )
        elif dd_bps * 100 >= ag.max_drawdown_bps * DRAWDOWN_WARN_PCT:
            alerts += await _alert_once(
                ctx, ag, "drawdown_80", "Drawdown warning",
                f"The portfolio is down {pct}% — past 80% of the {ag.max_drawdown_bps / 100:g}% max-loss limit.", data,
            )
    if ag.end_time is not None:
        remaining = ag.end_time - now
        data = {"end_time": ag.end_time.isoformat(), "value": str(value)}
        if remaining <= timedelta(0):
            alerts += await _alert_once(
                ctx, ag, "settle_now", "Agreement has expired",
                f"The term is over — settle it. Current value: {money.format_amount(value, base.decimals)} {base.code}.", data,
            )
        elif remaining <= timedelta(hours=1):
            alerts += await _alert_once(ctx, ag, "expiry_1h", "Agreement ends within the hour", "Once the term is over, anyone can settle it.", data)
        elif remaining <= timedelta(hours=24):
            alerts += await _alert_once(ctx, ag, "expiry_24h", "Agreement ends within 24 hours", "Review your positions; it can be settled once the term is over.", data)
    return alerts


async def sync_status_from_chain(ctx: IndexContext, ag: Agreement, chain: abi.Agreement) -> bool:
    """Bring a mirror row whose events were missed in line with `get_agreement` (no notifications)."""
    target = AgreementStatus.from_onchain(int(chain.status))
    if ag.status is target:
        return False
    log.warning("agreement %s (onchain %s) status %s != chain %s; syncing", ag.id, ag.onchain_id, ag.status.value, target.value)
    base = ag.base_asset
    ag.status = target
    ag.start_time = ts_to_dt(chain.start_time) or ag.start_time
    ag.end_time = ts_to_dt(chain.end_time) or ag.end_time
    if target is AgreementStatus.settled:
        ag.final_value = money.from_stroops(chain.final_value, base.decimals)
        ag.trader_fee = money.from_stroops(chain.trader_fee, base.decimals)
        ag.platform_fee = money.from_stroops(chain.platform_fee, base.decimals)
        ag.customer_payout = money.from_stroops(chain.customer_payout, base.decimals)
        ag.profit = max(Decimal("0"), ag.final_value - ag.principal)
        ag.settled_at = ts_to_dt(chain.settled_at) or now_utc()
        _set_value(ag, ag.final_value, ag.settled_at)
        _clear_balances(ag)
    elif target is AgreementStatus.cancelled:
        _clear_balances(ag)
    await ctx.db.flush()
    await refresh_trader_stats(ctx.db, ag.trader_id)
    return True


async def refresh_agreement_from_chain(
    ctx: IndexContext, ag: Agreement, *, snapshot: bool = True, alerts: bool = True, now: datetime | None = None
) -> dict[str, Any]:
    """`get_agreement` + `get_balances` + `value_in_base` -> mirror update for one agreement."""
    now = now or now_utc()
    result: dict[str, Any] = {"synced": False, "valued": False, "snapshot": False, "alerts": 0}
    if ag.onchain_id is None:
        return result
    chain = await _chain_agreement(ctx, int(ag.onchain_id))
    if chain is None:
        return result
    result["synced"] = await sync_status_from_chain(ctx, ag, chain)
    if AgreementStatus.from_onchain(int(chain.status)) is not AgreementStatus.active:
        return result
    balances = await ctx.soroban.get_balances(int(ag.onchain_id))
    raw_value = int(await ctx.soroban.value_in_base(int(ag.onchain_id)))
    value = money.from_stroops(raw_value, ag.base_asset.decimals)
    await _upsert_balances(ctx, ag, balances)
    _set_value(ag, value, now)
    result["valued"] = True
    if snapshot:
        _snapshot(ctx, ag, value, now)
        result["snapshot"] = True
    if alerts:
        result["alerts"] = await check_alerts(ctx, ag, value, now)
    await ctx.db.flush()
    return result


async def run_reconcile_once(db: AsyncSession, soroban: Any, settings: Settings, *, limit: int = 200) -> ReconcileResult:
    """One reconciler tick (worker: every `settings.reconcile_seconds`). Flush only."""
    ctx = IndexContext(db, settings, soroban)
    out = ReconcileResult()
    if not ctx.vault_id:
        return out
    rows = (
        await db.execute(
            select(Agreement)
            .where(Agreement.status.in_(list(OPEN_STATUSES)), Agreement.onchain_id.is_not(None))
            .order_by(Agreement.value_updated_at.asc().nulls_first())
            .limit(limit)
        )
    ).scalars().all()
    now = now_utc()
    for ag in rows:
        out.checked += 1
        try:
            async with db.begin_nested():
                r = await refresh_agreement_from_chain(ctx, ag, now=now)
        except Exception as e:  # noqa: BLE001 - keep going with the other agreements
            log.exception("reconcile: agreement %s failed", ag.id)
            out.errors.append(f"{ag.id}: {type(e).__name__}: {str(e)[:160]}")
            continue
        out.status_synced += int(bool(r["synced"]))
        out.valued += int(bool(r["valued"]))
        out.snapshots += int(bool(r["snapshot"]))
        out.alerts += int(r["alerts"])
    state = await _state(db, "reconcile")
    state.updated_at = now
    await db.flush()
    if out.checked:
        log.info("reconcile: %s", out.as_dict())
    return out


# --- trader stats -------------------------------------------------------------------------------


async def refresh_trader_stats(db: AsyncSession, trader_id: uuid.UUID) -> None:
    """Recompute the indexer-maintained `users` stats columns of a trader from the agreements mirror."""
    trader = await db.get(User, trader_id)
    if trader is None:
        return
    active_count, active_capital = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(Agreement.principal), 0)).where(
                Agreement.trader_id == trader_id, Agreement.status == AgreementStatus.active
            )
        )
    ).one()
    rows = (
        await db.execute(
            select(Agreement.status, Agreement.principal, Agreement.final_value, Agreement.current_value, Agreement.settled_at).where(
                Agreement.trader_id == trader_id, Agreement.status.in_([AgreementStatus.active, AgreementStatus.settled])
            )
        )
    ).all()
    month_ago = now_utc() - timedelta(days=30)
    total_p = total_v = month_p = month_v = Decimal("0")
    wins = settled = 0
    max_dd = 0
    for status, principal, final_value, current_value, settled_at in rows:
        principal = Decimal(principal)
        value = Decimal(final_value if status is AgreementStatus.settled and final_value is not None else (current_value or principal))
        total_p += principal
        total_v += value
        if status is AgreementStatus.settled:
            settled += 1
            wins += int(value > principal)
            if settled_at is not None and settled_at >= month_ago:
                month_p += principal
                month_v += value
        elif status is AgreementStatus.active:
            month_p += principal
            month_v += value
        if principal > 0 and value < principal:
            max_dd = max(max_dd, int((principal - value) * money.BPS_DENOM / principal))
    trader.active_agreements = int(active_count or 0)
    trader.managed_capital = money.quantize(Decimal(active_capital or 0))
    trader.total_return_bps = int((total_v - total_p) * money.BPS_DENOM / total_p) if total_p > 0 else 0
    trader.monthly_return_bps = int((month_v - month_p) * money.BPS_DENOM / month_p) if month_p > 0 else 0
    trader.win_rate_bps = int(wins * money.BPS_DENOM / settled) if settled else 0
    trader.max_drawdown_bps = max_dd
    await db.flush()


__all__ = [
    "EVENT_PAGE",
    "LOOKBACK_LEDGERS",
    "VAULT_EVENTS_KEY",
    "IndexContext",
    "IndexerRunResult",
    "ReconcileResult",
    "apply_event",
    "apply_tx_result",
    "check_alerts",
    "expire_pending",
    "finalize_submitted",
    "refresh_agreement_from_chain",
    "refresh_trader_stats",
    "run_indexer_once",
    "run_reconcile_once",
    "sync_status_from_chain",
]
