"""Trading (Figma 4a/4b "Yeni İşlem"): router quotes with drawdown headroom, the unsigned `trade`
transaction (min_out from the quote) and the trader's off-chain note on an indexed trade.

The contract enforces `value_after >= principal × (1 − max_drawdown)` (CONTRACT §3.2); the quote here
re-computes that check from the same router quotes so the app can show the headroom before signing.
"""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import ForbiddenError, NotFoundError, StateError, StellarError, ValidationError
from app.models import Agreement, AgreementStatus, Asset, PendingTxKind, Trade, User, UserRole
from app.schemas.trades import QuoteOut, TradeNoteIn, TradeOut, TradeTxIn
from app.schemas.tx import UnsignedTxOut
from app.services import amounts as money
from app.services.agreements import (
    asset_brief,
    get_agreement_row,
    is_expired,
    now_utc,
    party_role,
    principal_raw,
    record_pending,
    unsigned_out,
)
from app.services.stellar.contract_abi import MAX_TOKENS

log = logging.getLogger(__name__)

REASON_MESSAGES = {
    "expired": "the agreement has reached its end time; only settle is possible",
    "token_not_allowed": "one of the tokens is not allow-listed on the vault",
    "same_token": "token_in and token_out must differ",
    "insufficient_balance": "the agreement holds less of token_in than amount_in",
    "too_many_tokens": "the agreement already holds the maximum number of tokens",
    "no_liquidity": "the router returns nothing for this amount",
    "drawdown_breached": "the trade would push the portfolio value below the max-drawdown floor",
}


# --- input parsing ------------------------------------------------------------------------------


def parse_amount(value: Decimal | str, *, decimals: int = money.DEFAULT_DECIMALS) -> Decimal:
    """Amount from the API (decimal string): finite, > 0, at most `decimals` places."""
    try:
        d = Decimal(str(value).strip())
    except (InvalidOperation, ValueError) as e:
        raise ValidationError(f"amount {value!r} is not a decimal number", code="invalid_amount") from e
    if not d.is_finite() or d <= 0:
        raise ValidationError("amount must be a positive number", code="invalid_amount")
    if d != money.quantize(d, decimals):
        raise ValidationError(f"amount has more than {decimals} decimal places", code="invalid_amount")
    return d


# --- asset resolution ---------------------------------------------------------------------------


async def resolve_asset(db: AsyncSession, settings: Settings, ref: str) -> Asset:
    """`ref` is an asset uuid, a C... contract id, or an asset code that is unique among the network's
    active assets (base-allowed rows win when a code is ambiguous, e.g. the two testnet USDCs)."""
    ref = (ref or "").strip()
    if not ref:
        raise ValidationError("token is required", code="invalid_token")
    network = settings.stellar_network
    asset: Asset | None = None
    try:
        asset = await db.get(Asset, uuid.UUID(ref))
    except ValueError:
        pass
    if asset is None and len(ref) == 56 and ref.startswith("C"):
        asset = (
            await db.execute(select(Asset).where(Asset.network == network, Asset.contract_id == ref))
        ).scalar_one_or_none()
    if asset is None:
        rows = (
            await db.execute(
                select(Asset).where(
                    Asset.network == network, Asset.is_active.is_(True), Asset.code == ref.upper()
                )
            )
        ).scalars().all()
        if len(rows) == 1:
            asset = rows[0]
        elif len(rows) > 1:
            preferred = [a for a in rows if a.is_base_allowed and a.onchain_allowed] or [a for a in rows if a.is_base_allowed]
            if len(preferred) == 1:
                asset = preferred[0]
            else:
                raise ValidationError(
                    f"asset code {ref!r} is ambiguous; use the asset id or contract id",
                    code="ambiguous_token",
                    details={"candidates": [str(a.id) for a in rows]},
                )
    if asset is None or asset.network != network:
        raise NotFoundError(f"asset {ref!r} not found", code="asset_not_found")
    return asset


def symbol_label(token_in: Asset, token_out: Asset, base: Asset) -> str:
    """Trade label, e.g. "XLM/USDC · Buy". Spending the base token is a Buy, going back to the base is
    a Sell, anything else is a Swap. The app is in English, so these labels are too."""
    if token_in.contract_id == base.contract_id:
        return f"{token_out.code}/{token_in.code} · Buy"
    if token_out.contract_id == base.contract_id:
        return f"{token_in.code}/{token_out.code} · Sell"
    return f"{token_out.code}/{token_in.code} · Swap"


# --- quote --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Quote:
    out: QuoteOut
    amount_in_raw: int
    amount_out_raw: int
    min_out_raw: int
    token_in: Asset
    token_out: Asset


async def _in_base(soroban: Any, token: str, amount: int, base: str) -> int:
    """Value of `amount` of `token` in base units via the router (0 when unquotable, like the contract)."""
    if amount <= 0:
        return 0
    if token == base:
        return int(amount)
    try:
        return int(await soroban.router_quote(token, base, amount))
    except StellarError:
        return 0


def _price(amount_in: Decimal, amount_out: Decimal) -> Decimal:
    if amount_in <= 0:
        return Decimal("0")
    return (amount_out / amount_in).quantize(Decimal("0.0000001"))


async def compute_quote(
    db: AsyncSession,
    settings: Settings,
    soroban: Any,
    agreement: Agreement,
    user: User,
    *,
    token_in: str,
    token_out: str,
    amount_in: Decimal | str,
    slippage_bps: int | None = None,
    deadline_seconds: int = 300,
) -> Quote:
    """Router quote + drawdown headroom for a party of an *active* agreement."""
    amount_in = parse_amount(amount_in)
    if party_role(agreement, user) is None and not user.is_admin:
        raise ForbiddenError("You are not a party of this agreement", code="not_party")
    if agreement.status is not AgreementStatus.active:
        raise StateError(
            f"agreement is {agreement.status.value}; trading needs an active agreement", code="invalid_state"
        )
    if agreement.onchain_id is None:
        raise StateError("agreement is not on-chain yet", code="not_onchain")
    a_in = await resolve_asset(db, settings, token_in)
    a_out = await resolve_asset(db, settings, token_out)
    if a_in.id == a_out.id:
        raise ValidationError(REASON_MESSAGES["same_token"], code="same_token")
    bps = settings.default_trade_slippage_bps if slippage_bps is None else int(slippage_bps)
    try:
        amount_in_raw = money.to_stroops(parse_amount(amount_in, decimals=a_in.decimals), a_in.decimals)
    except ValueError as e:
        raise ValidationError(str(e), code="invalid_amount") from e

    onchain_id = int(agreement.onchain_id)
    base = agreement.base_asset
    chain = await soroban.get_agreement(onchain_id)
    balances = dict(await soroban.get_balances(onchain_id))
    value_before = int(await soroban.value_in_base(onchain_id))
    in_cid, out_cid, base_cid = a_in.contract_id, a_out.contract_id, base.contract_id
    balance_in = int(balances.get(in_cid, 0))

    try:
        amount_out_raw = int(await soroban.router_quote(in_cid, out_cid, amount_in_raw))
    except StellarError as e:
        if e.code == "quote_failed":
            raise StateError(f"no route for {a_in.code} -> {a_out.code} on the router", code="no_route") from e
        raise
    in_leg = await _in_base(soroban, in_cid, amount_in_raw, base_cid)
    out_leg = await _in_base(soroban, out_cid, amount_out_raw, base_cid)
    value_after = value_before - in_leg + out_leg
    p_raw = principal_raw(agreement)
    floor = money.drawdown_floor(p_raw, agreement.max_drawdown_bps)
    headroom = value_after - floor
    headroom_bps = int(headroom * 10_000 // p_raw) if p_raw > 0 else 0

    reason: str | None = None
    if is_expired(agreement) or (chain.end_time and int(time.time()) >= chain.end_time):
        reason = "expired"
    else:
        allowed_in = await soroban.is_token_allowed(in_cid)
        allowed_out = await soroban.is_token_allowed(out_cid)
        if not (allowed_in.allowed and allowed_out.allowed):
            reason = "token_not_allowed"
        elif balance_in < amount_in_raw:
            reason = "insufficient_balance"
        elif out_cid not in chain.tokens and len(chain.tokens) >= MAX_TOKENS:
            reason = "too_many_tokens"
        elif amount_out_raw <= 0:
            reason = "no_liquidity"
        elif headroom < 0:
            reason = "drawdown_breached"

    api_out: Decimal | None = None
    impact: Decimal | None = None
    try:
        api = await soroban.soroswap_api_quote(in_cid, out_cid, amount_in_raw, bps)
    except Exception as e:  # noqa: BLE001 - optional enrichment
        log.debug("soroswap api quote skipped: %s", e)
        api = None
    if api is not None:
        api_out = money.from_stroops(api.amount_out, a_out.decimals)
        impact = api.price_impact_pct
    min_out_raw = money.min_out_for_slippage(amount_out_raw, bps)
    amount_in_d = money.from_stroops(amount_in_raw, a_in.decimals)
    amount_out_d = money.from_stroops(amount_out_raw, a_out.decimals)
    out = QuoteOut(
        agreement_id=agreement.id,
        onchain_id=onchain_id,
        token_in=asset_brief(a_in),
        token_out=asset_brief(a_out),
        amount_in=amount_in_d,
        amount_out=amount_out_d,
        min_out=money.from_stroops(min_out_raw, a_out.decimals),
        slippage_bps=bps,
        price=_price(amount_in_d, amount_out_d),
        source="router" if getattr(soroban, "rpc_url", "").startswith("http") else "fake",
        api_amount_out=api_out,
        price_impact_pct=impact,
        balance_in=money.from_stroops(balance_in, a_in.decimals),
        value_before=money.from_stroops(value_before, base.decimals),
        value_after_estimate=money.from_stroops(value_after, base.decimals),
        principal=agreement.principal,
        max_drawdown_bps=agreement.max_drawdown_bps,
        drawdown_floor=money.from_stroops(floor, base.decimals),
        headroom=money.from_stroops(headroom, base.decimals),
        headroom_bps=headroom_bps,
        allowed=reason is None,
        reason=reason,
        deadline_seconds=int(deadline_seconds),
        quoted_at=now_utc(),
    )
    return Quote(out=out, amount_in_raw=amount_in_raw, amount_out_raw=amount_out_raw, min_out_raw=min_out_raw, token_in=a_in, token_out=a_out)


# --- trade tx -----------------------------------------------------------------------------------


async def build_trade_tx(
    db: AsyncSession, settings: Settings, soroban: Any, agreement: Agreement, user: User, body: TradeTxIn
) -> UnsignedTxOut:
    """`POST /agreements/{id}/tx/trade` (trader only, active, before end_time)."""
    if party_role(agreement, user) is not UserRole.trader:
        raise ForbiddenError("only the trader may trade on this agreement", code="wrong_party")
    q = await compute_quote(
        db,
        settings,
        soroban,
        agreement,
        user,
        token_in=body.token_in,
        token_out=body.token_out,
        amount_in=body.amount_in,
        slippage_bps=body.slippage_bps,
        deadline_seconds=body.deadline_seconds,
    )
    if not q.out.allowed:
        reason = q.out.reason or "rejected"
        raise StateError(REASON_MESSAGES.get(reason, reason), code=reason, details={"quote": q.out.model_dump(mode="json")})
    if q.min_out_raw <= 0:
        raise StateError("min_out would be zero; increase amount_in or lower slippage", code="min_out_zero")
    deadline = int(time.time()) + int(body.deadline_seconds)
    unsigned = await soroban.build_trade(
        user.stellar_address,
        int(agreement.onchain_id),
        q.token_in.contract_id,
        q.token_out.contract_id,
        q.amount_in_raw,
        q.min_out_raw,
        deadline,
    )
    label = symbol_label(q.token_in, q.token_out, agreement.base_asset)
    payload = {
        "note": body.note,
        "notify_investors": bool(body.notify_investors),
        "symbol_label": label,
        "token_in_id": str(q.token_in.id),
        "token_out_id": str(q.token_out.id),
        "token_in_code": q.token_in.code,
        "token_out_code": q.token_out.code,
        "amount_in": str(q.out.amount_in),
        "amount_out_quote": str(q.out.amount_out),
        "min_out": str(q.out.min_out),
        "slippage_bps": q.out.slippage_bps,
        "value_after_estimate": str(q.out.value_after_estimate),
        "headroom_bps": q.out.headroom_bps,
    }
    pending = await record_pending(db, user, PendingTxKind.trade, agreement, unsigned, payload)
    log.info(
        "trade tx built agreement=%s %s %s -> %s min_out=%s pending=%s",
        agreement.id, q.amount_in_raw, q.token_in.code, q.token_out.code, q.min_out_raw, pending.id,
    )
    return unsigned_out(pending, unsigned, user.stellar_address)


# --- trades -------------------------------------------------------------------------------------


def trade_out(trade: Trade, agreement: Agreement | None = None) -> TradeOut:
    return TradeOut(
        id=trade.id,
        agreement_id=trade.agreement_id,
        onchain_id=agreement.onchain_id if agreement is not None else None,
        onchain_seq=trade.onchain_seq,
        tx_hash=trade.tx_hash,
        ledger=trade.ledger,
        trader_id=trade.trader_id,
        token_in=asset_brief(trade.token_in),
        token_out=asset_brief(trade.token_out),
        amount_in=trade.amount_in,
        amount_out=trade.amount_out,
        price=_price(trade.amount_in, trade.amount_out),
        value_after=trade.value_after,
        note=trade.note,
        symbol_label=trade.symbol_label,
        notify_investors=trade.notify_investors,
        created_at=trade.created_at,
    )


async def get_trade(db: AsyncSession, trade_id: uuid.UUID) -> Trade:
    trade = await db.get(Trade, trade_id)
    if trade is None:
        raise NotFoundError("Trade not found", code="trade_not_found")
    return trade


async def update_trade_note(db: AsyncSession, user: User, trade_id: uuid.UUID, body: TradeNoteIn) -> tuple[Trade, Agreement]:
    """`PATCH /trades/{id}`: only the agreement's trader may edit the note / notify flag."""
    trade = await get_trade(db, trade_id)
    agreement = await get_agreement_row(db, trade.agreement_id)
    if agreement.trader_id != user.id and not user.is_admin:
        raise ForbiddenError("only the trader may edit this trade", code="wrong_party")
    changes = body.model_dump(exclude_unset=True)
    if "note" in changes:
        trade.note = changes["note"]
    if changes.get("notify_investors") is not None:
        trade.notify_investors = bool(changes["notify_investors"])
    if changes:
        await db.flush()
    return trade, agreement


__all__ = [
    "REASON_MESSAGES",
    "Quote",
    "build_trade_tx",
    "compute_quote",
    "get_trade",
    "parse_amount",
    "resolve_asset",
    "symbol_label",
    "trade_out",
    "update_trade_note",
]
