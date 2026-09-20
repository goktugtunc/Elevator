"""Signed transaction submit + pending transaction status (DESIGN §2.4 mobile signing model)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter

from app.api_deps import DB, CurrentUser, SettingsDep, SorobanDep
from app.schemas.tx import PendingTxOut, TxSubmitIn, TxSubmitOut
from app.services import tx_submit

router = APIRouter(prefix="/tx", tags=["tx"])


@router.post("/submit", response_model=TxSubmitOut)
async def submit(body: TxSubmitIn, db: DB, user: CurrentUser, settings: SettingsDep, soroban=SorobanDep) -> TxSubmitOut:
    """Send the user-signed envelope of `pending_tx_id` through RPC, poll up to
    `tx_submit_timeout_seconds` and return `{tx_hash, status, result}`. The pending row must belong to the
    caller, be unexpired and match the envelope hash. `status=FAILED` carries the contract error (code +
    name); `status=PENDING` means the poll window elapsed — `GET /tx/{id}` keeps polling."""
    return await tx_submit.submit_signed(db, settings, soroban, user, body.pending_tx_id, body.signed_xdr)


@router.get("/{pending_id}", response_model=PendingTxOut)
async def get_pending(pending_id: uuid.UUID, db: DB, user: CurrentUser, settings: SettingsDep, soroban=SorobanDep) -> PendingTxOut:
    """A pending transaction of the caller (unsigned XDR, status, result); submitted rows are re-polled."""
    pending = await tx_submit.get_pending(db, settings, soroban, user, pending_id)
    return PendingTxOut.model_validate(pending)


__all__ = ["router"]
