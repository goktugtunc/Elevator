"""Agreements / Sözleşme (Figma 9d, 3a, 5c) and trading (4a/4b) endpoints — DESIGN §2.3."""
from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.api_deps import DB, CurrentUser, SettingsDep, SorobanDep
from app.api_paging import PageDep
from app.core.errors import StellarError
from app.models import AgreementStatus, UserRole
from app.schemas.agreements import AgreementOut, ValueHistoryOut, ValueRange
from app.schemas.common import Page
from app.schemas.trades import QuoteOut, TradeOut, TradeTxIn
from app.schemas.tx import TxAction, TxActionIn, UnsignedTxOut
from app.services import agreements as svc
from app.services import trading
from app.services.agreements import OPEN_STATUSES
from app.services.indexer import IndexContext, refresh_agreement_from_chain

log = logging.getLogger(__name__)

router = APIRouter(prefix="/agreements", tags=["agreements"])


@router.get("", response_model=Page[AgreementOut])
async def list_agreements(
    db: DB,
    user: CurrentUser,
    settings: SettingsDep,
    page: PageDep,
    role: Annotated[UserRole | None, Query(description="side you play: customer | trader (default both)")] = None,
    status: Annotated[
        str | None, Query(description="draft|proposed|funded|active|settled|cancelled|failed or open|closed")
    ] = None,
    soroban=SorobanDep,
) -> Page[AgreementOut]:
    """Agreements the caller is party to, newest activity first, with TL equivalents."""
    rows, total = await svc.list_agreements(db, user, role=role, status=status, limit=page.limit, offset=page.offset)
    items = await svc.serialize_many(db, settings, soroban, rows, user)
    return Page[AgreementOut](items=items, total=total, limit=page.limit, offset=page.offset)


@router.get("/{agreement_id}", response_model=AgreementOut)
async def get_agreement(
    agreement_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    settings: SettingsDep,
    refresh: Annotated[bool, Query(description="read live value/balances from the contract (open agreements)")] = True,
    soroban=SorobanDep,
) -> AgreementOut:
    """Terms, status, balances, value, P&L, tx hashes, TL equivalents and the actions the caller may take."""
    ag = await svc.get_agreement_for(db, agreement_id, user)
    if refresh and ag.status in OPEN_STATUSES and ag.onchain_id is not None:
        try:
            await refresh_agreement_from_chain(IndexContext(db, settings, soroban), ag, snapshot=False, alerts=False)
            await db.refresh(ag)
        except StellarError as e:  # the mirror is still served when RPC is down
            log.warning("live refresh of agreement %s skipped: %s", ag.id, e.message)
    return await svc.serialize_one(db, settings, soroban, ag, user)


@router.post("/{agreement_id}/tx/trade", response_model=UnsignedTxOut)
async def build_trade(
    agreement_id: uuid.UUID, body: TradeTxIn, db: DB, user: CurrentUser, settings: SettingsDep, soroban=SorobanDep
) -> UnsignedTxOut:
    """Unsigned `trade(id, token_in, token_out, amount_in, min_out, deadline)` for the trader (Figma 4b).
    `min_out` comes from the router quote minus `slippage_bps`; the note / notify flag are attached to the
    trade row once the indexer sees the `Traded` event."""
    ag = await svc.get_agreement_for(db, agreement_id, user)
    return await trading.build_trade_tx(db, settings, soroban, ag, user, body)


@router.post("/{agreement_id}/tx/{action}", response_model=UnsignedTxOut)
async def build_action(
    agreement_id: uuid.UUID,
    action: TxAction,
    db: DB,
    user: CurrentUser,
    settings: SettingsDep,
    body: TxActionIn | None = None,
    soroban=SorobanDep,
) -> UnsignedTxOut:
    """Unsigned XDR (source = caller) for open | propose | fund | accept | cancel | settle. Role/status rules:
    draft+customer -> open, draft+trader -> propose, proposed+customer -> fund, funded+trader -> accept,
    proposed (proposer) / funded (either party) -> cancel, active -> settle by a party any time or by anyone
    after end_time. Sign it and `POST /tx/submit`."""
    ag = await svc.get_agreement_row(db, agreement_id)  # non-parties may settle after expiry
    return await svc.build_action_tx(
        db, settings, soroban, ag, user, action, slippage_bps=body.slippage_bps if body else None
    )


@router.get("/{agreement_id}/quote", response_model=QuoteOut)
async def quote(
    agreement_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    settings: SettingsDep,
    token_in: Annotated[str, Query(description="asset id, contract id or code")],
    token_out: Annotated[str, Query(description="asset id, contract id or code")],
    amount_in: Annotated[str, Query(description="decimal string, > 0, at most 7 dp")],
    slippage_bps: Annotated[int | None, Query(ge=0, le=5_000)] = None,
    deadline_seconds: Annotated[int, Query(ge=30, le=3_600)] = 300,
    soroban=SorobanDep,
) -> QuoteOut:
    """Router quote via the vault's Soroswap router (simulation) + drawdown headroom (Figma 4a)."""
    ag = await svc.get_agreement_for(db, agreement_id, user)
    q = await trading.compute_quote(
        db, settings, soroban, ag, user,
        token_in=token_in, token_out=token_out, amount_in=amount_in, slippage_bps=slippage_bps, deadline_seconds=deadline_seconds,
    )
    return q.out


@router.get("/{agreement_id}/trades", response_model=Page[TradeOut])
async def list_trades(agreement_id: uuid.UUID, db: DB, user: CurrentUser, page: PageDep) -> Page[TradeOut]:
    ag = await svc.get_agreement_for(db, agreement_id, user)
    rows, total = await svc.list_trades(db, ag, limit=page.limit, offset=page.offset)
    return Page[TradeOut](items=[trading.trade_out(t, ag) for t in rows], total=total, limit=page.limit, offset=page.offset)


@router.get("/{agreement_id}/value-history", response_model=ValueHistoryOut)
async def value_history(
    agreement_id: uuid.UUID,
    db: DB,
    user: CurrentUser,
    range: Annotated[ValueRange, Query(description="24h | 7d | 30d | 90d | all")] = "7d",  # noqa: A002
) -> ValueHistoryOut:
    """Value snapshots (reconciler + event-time values) for the agreement chart."""
    ag = await svc.get_agreement_for(db, agreement_id, user)
    return await svc.value_history(db, ag, range)


__all__ = ["router", "AgreementStatus"]
