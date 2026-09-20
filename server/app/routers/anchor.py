"""Anchor endpoints — Cüzdan → Yatır / Çek through SEP-1 / SEP-10 / SEP-24 / SEP-12 (DESIGN §3.1).

Flow for the mobile app:
  GET  /anchor/info                       capabilities, limits, session state
  POST /anchor/auth/challenge             verified SEP-10 challenge -> sign with the wallet key (never submit)
  POST /anchor/auth/token {signed_xdr}    backend exchanges it with the anchor; JWT stored encrypted server-side
  POST /anchor/deposit | /withdraw        SEP-24 interactive url -> open in a system webview (postMessage)
  GET  /anchor/transactions[/{id}]        mirrored status state machine (+ `action` for the UI)
  POST /anchor/transactions/{id}/tx/payment  unsigned payment with the anchor's exact memo (withdraw leg)
  POST /anchor/kyc                        SEP-12 pass-through when the anchor needs fields up front
A 401 `anchor_auth_required` on any of them means: run challenge + token again, then retry.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api_deps import DB, CurrentUser, HorizonDep, OptionalUser, SettingsDep, SorobanDep
from app.models import AnchorTxKind
from app.schemas.anchor import (
    AnchorInfoOut,
    AnchorSessionOut,
    AnchorTransactionListOut,
    AnchorTransactionOut,
    ChallengeIn,
    ChallengeOut,
    InteractiveIn,
    InteractiveOut,
    KycIn,
    KycOut,
    TokenIn,
)
from app.schemas.tx import UnsignedTxOut
from app.services import anchor as anchor_service
from app.services.agreements import unsigned_out
from app.services.anchor import AnchorClient, get_anchor_client

router = APIRouter(prefix="/anchor", tags=["anchor"])

AnchorDep = Depends(get_anchor_client)


@router.get("/info", response_model=AnchorInfoOut)
async def info(
    db: DB,
    settings: SettingsDep,
    user: OptionalUser,
    lang: Annotated[str | None, Query(min_length=2, max_length=8)] = None,
    anchor: AnchorClient = AnchorDep,
) -> AnchorInfoOut:
    """stellar.toml + SEP-24 `/info` of the configured anchor (assets, min/max, fees, features) and, with a
    token, whether the caller already holds an anchor session."""
    return await anchor_service.anchor_info(db, settings, anchor, user, lang=lang)


@router.get("/auth/session", response_model=AnchorSessionOut)
async def session(db: DB, user: CurrentUser, anchor: AnchorClient = AnchorDep) -> AnchorSessionOut:
    """Whether the caller has a live SEP-10 session with the anchor (the JWT itself is never returned)."""
    return anchor_service.session_out(anchor.domain, await anchor_service.get_session(db, user.id, anchor.domain))


@router.post("/auth/challenge", response_model=ChallengeOut)
async def challenge(user: CurrentUser, body: ChallengeIn | None = None, anchor: AnchorClient = AnchorDep) -> ChallengeOut:
    """SEP-10 step 1: fetch the anchor's challenge for the caller's wallet and return it only after verifying
    the anchor signature, sequence 0, time bounds, home domain and web_auth_domain. Sign it; do NOT submit."""
    return await anchor_service.challenge_for_user(anchor, user, memo=body.memo if body else None)


@router.post("/auth/token", response_model=AnchorSessionOut)
async def token(body: TokenIn, db: DB, settings: SettingsDep, user: CurrentUser, anchor: AnchorClient = AnchorDep) -> AnchorSessionOut:
    """SEP-10 step 3: forward the user-signed challenge to the anchor and store its JWT (encrypted)."""
    return await anchor_service.exchange_token(db, settings, anchor, user, body.signed_xdr)


@router.post("/deposit", response_model=InteractiveOut, status_code=201)
async def deposit(
    body: InteractiveIn, db: DB, settings: SettingsDep, user: CurrentUser, anchor: AnchorClient = AnchorDep, horizon=HorizonDep
) -> InteractiveOut:
    """Yatır: start a SEP-24 interactive deposit. Pre-validates `/info` limits and the trustline
    (409 `trustline_required` -> POST /wallet/tx/trustline first). Open `interactive_url` in a system webview."""
    tx = await anchor_service.start_interactive(
        db, settings, anchor, horizon, user,
        kind=AnchorTxKind.deposit, asset_code=body.asset_code, asset_issuer=body.asset_issuer, amount=body.amount,
        lang=body.lang, callback=body.callback, claimable_balance_supported=body.claimable_balance_supported,
        skip_trustline_check=body.skip_trustline_check,
    )
    return anchor_service.interactive_out(tx)


@router.post("/withdraw", response_model=InteractiveOut, status_code=201)
async def withdraw(
    body: InteractiveIn, db: DB, settings: SettingsDep, user: CurrentUser, anchor: AnchorClient = AnchorDep, horizon=HorizonDep
) -> InteractiveOut:
    """Çek: start a SEP-24 interactive withdrawal. When the anchor reaches `pending_user_transfer_start`,
    build the payment with POST /anchor/transactions/{id}/tx/payment and submit it via POST /tx/submit."""
    tx = await anchor_service.start_interactive(
        db, settings, anchor, horizon, user,
        kind=AnchorTxKind.withdraw, asset_code=body.asset_code, asset_issuer=body.asset_issuer, amount=body.amount,
        lang=body.lang, callback=body.callback,
    )
    return anchor_service.interactive_out(tx)


@router.get("/transactions", response_model=AnchorTransactionListOut)
async def list_transactions(
    db: DB,
    settings: SettingsDep,
    user: CurrentUser,
    kind: Annotated[AnchorTxKind | None, Query()] = None,
    status: Annotated[str | None, Query(max_length=40)] = None,
    asset_code: Annotated[str | None, Query(max_length=12)] = None,
    sync: Annotated[bool, Query(description="poll the anchor for non-terminal transactions first")] = True,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    anchor: AnchorClient = AnchorDep,
) -> AnchorTransactionListOut:
    """Cüzdan "Son işlemler": the caller's anchor deposits / withdrawals, newest first, refreshed from the
    anchor when a session exists (`auth_required=true` otherwise)."""
    rows, result = await anchor_service.list_user_transactions(
        db, settings, anchor, user, kind=kind, status=status, asset_code=asset_code, sync=sync
    )
    page = rows[offset : offset + limit]
    return AnchorTransactionListOut(
        items=[anchor_service.transaction_out(t) for t in page],
        total=len(rows),
        synced=result.synced,
        auth_required=result.auth_required,
        sync_error=result.error,
    )


@router.get("/transactions/{tx_ref}", response_model=AnchorTransactionOut)
async def get_transaction(
    tx_ref: str,
    db: DB,
    settings: SettingsDep,
    user: CurrentUser,
    refresh: Annotated[bool, Query(description="poll the anchor before answering")] = True,
    anchor: AnchorClient = AnchorDep,
) -> AnchorTransactionOut:
    """One anchor transaction by our id or the anchor's id (owner only)."""
    tx = await anchor_service.get_user_transaction(db, user, tx_ref, anchor.domain)
    if refresh:
        await anchor_service.refresh_user_transaction(db, settings, anchor, user, tx)
    return anchor_service.transaction_out(tx)


@router.post("/transactions/{tx_ref}/tx/payment", response_model=UnsignedTxOut)
async def withdraw_payment(
    tx_ref: str, db: DB, settings: SettingsDep, user: CurrentUser, anchor: AnchorClient = AnchorDep, soroban=SorobanDep
) -> UnsignedTxOut:
    """Withdraw leg: unsigned classic payment from the caller to `withdraw_anchor_account` with the anchor's
    exact `withdraw_memo` / `withdraw_memo_type` and `amount_in`. Sign, then POST /tx/submit."""
    tx = await anchor_service.get_user_transaction(db, user, tx_ref, anchor.domain)
    if tx.status != "pending_user_transfer_start":
        await anchor_service.refresh_user_transaction(db, settings, anchor, user, tx)
    pending, unsigned = await anchor_service.build_withdraw_payment(db, settings, soroban, user, tx)
    return unsigned_out(pending, unsigned, user.stellar_address)


@router.post("/kyc", response_model=KycOut)
async def kyc(body: KycIn, db: DB, settings: SettingsDep, user: CurrentUser, anchor: AnchorClient = AnchorDep) -> KycOut:
    """SEP-12 pass-through (`PUT {KYC_SERVER}/customer` + status). Nothing but the customer id comes back;
    no PII is stored server-side."""
    return await anchor_service.kyc(db, settings, anchor, user, body)


__all__ = ["router", "AnchorDep"]
