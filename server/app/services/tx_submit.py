"""`POST /tx/submit` (DESIGN §2.3/§2.4): the app returns the signed envelope of a pending transaction,
the backend validates ownership / expiry / hash, sends it through the Soroban RPC gateway, polls
`getTransaction` up to `settings.tx_submit_timeout_seconds` and applies the outcome (events -> mirror rows
+ notifications via `app.services.indexer`). Rejections at send time are recorded on the pending row and
returned as `status=FAILED` (HTTP 200) so the row state survives the request.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import ForbiddenError, NotFoundError, StateError, StellarError, ValidationError
from app.models import Agreement, PendingTransaction, PendingTxKind, PendingTxStatus, Trade, User
from app.schemas.tx import TxSubmitOut
from app.services.agreements import json_safe, now_utc
from app.services.indexer import IndexContext, apply_tx_result
from app.services.stellar.contract_abi import VaultContractError, VaultError
from app.services.stellar.types import TxRejectedError, TxResult
from app.services.stellar.xdr_utils import envelope_from_xdr

log = logging.getLogger(__name__)


async def _owned_pending(db: AsyncSession, user: User, pending_id: uuid.UUID, *, lock: bool = False) -> PendingTransaction:
    pending = await db.get(PendingTransaction, pending_id, with_for_update=lock)
    if pending is None:
        raise NotFoundError("Pending transaction not found", code="pending_tx_not_found")
    if pending.user_id != user.id and not user.is_admin:
        raise ForbiddenError("This pending transaction belongs to another user", code="not_owner")
    return pending


def _check_expiry(pending: PendingTransaction) -> None:
    if pending.status is PendingTxStatus.expired or (
        pending.status is PendingTxStatus.built and pending.expires_at <= now_utc()
    ):
        if pending.status is PendingTxStatus.built:
            pending.status = PendingTxStatus.expired
            pending.result = {"status": "EXPIRED", "reason": "not_signed_in_time"}
        raise StateError(
            "pending transaction expired; build a new one", code="pending_tx_expired", details={"expires_at": pending.expires_at.isoformat()}
        )


def _verify_envelope(settings: Settings, pending: PendingTransaction, signed_xdr: str) -> None:
    try:
        env = envelope_from_xdr(signed_xdr, settings.network_passphrase)
    except StellarError as e:
        raise ValidationError(f"signed_xdr is not a valid envelope: {e.message}", code="invalid_xdr") from e
    if not env.signatures:
        raise ValidationError("signed_xdr carries no signature", code="unsigned_xdr")
    if pending.tx_hash and env.hash_hex() != pending.tx_hash:
        raise ValidationError(
            "signed_xdr does not match the pending transaction (hash mismatch)",
            code="xdr_mismatch",
            details={"expected": pending.tx_hash, "got": env.hash_hex()},
        )


async def _out(db: AsyncSession, pending: PendingTransaction, res: TxResult | None, applied: dict[str, Any] | None) -> TxSubmitOut:
    result = dict(pending.result or {})
    agreement: Agreement | None = None
    if pending.agreement_id is not None:
        agreement = await db.get(Agreement, pending.agreement_id)
    trade_id: uuid.UUID | None = None
    if pending.kind is PendingTxKind.trade and pending.tx_hash and pending.status is PendingTxStatus.success:
        trade_id = (
            await db.execute(select(Trade.id).where(Trade.tx_hash == pending.tx_hash).order_by(Trade.onchain_seq).limit(1))
        ).scalar_one_or_none()
    if pending.status is PendingTxStatus.success:
        status = "SUCCESS"
    elif pending.status is PendingTxStatus.failed:
        status = "FAILED"
    else:
        status = "PENDING"
    code = result.get("contract_error_code")
    err = VaultError.from_code(code) if code is not None else None
    return TxSubmitOut(
        pending_tx_id=pending.id,
        kind=pending.kind,
        tx_hash=pending.tx_hash or (res.hash if res else ""),
        status=status,  # type: ignore[arg-type]
        pending_status=pending.status,
        ledger=result.get("ledger") if result.get("ledger") is not None else (res.ledger if res else None),
        result=result or None,
        error=result.get("error"),
        contract_error=result.get("contract_error") or (err.name if err else None),
        contract_error_code=code,
        agreement_id=pending.agreement_id,
        agreement_status=agreement.status if agreement is not None else None,
        onchain_id=agreement.onchain_id if agreement is not None else None,
        trade_id=trade_id,
        events=list((applied or {}).get("events") or result.get("events") or []),
    )


async def submit_signed(
    db: AsyncSession, settings: Settings, soroban: Any, user: User, pending_tx_id: uuid.UUID, signed_xdr: str
) -> TxSubmitOut:
    pending = await _owned_pending(db, user, pending_tx_id, lock=True)
    if pending.status in (PendingTxStatus.success, PendingTxStatus.failed):
        return await _out(db, pending, None, None)  # idempotent replay
    _check_expiry(pending)
    _verify_envelope(settings, pending, signed_xdr)
    ctx = IndexContext(db, settings, soroban)
    if pending.status is PendingTxStatus.submitted and pending.tx_hash:
        tx_hash = pending.tx_hash  # already sent: just poll again
    else:
        pending.status = PendingTxStatus.submitted
        pending.submitted_at = now_utc()
        await db.flush()
        try:
            tx_hash = await soroban.send(signed_xdr)
        except (TxRejectedError, VaultContractError) as e:
            pending.status = PendingTxStatus.failed
            pending.result = json_safe(
                {
                    "status": "FAILED",
                    "error": e.message,
                    "code": e.code,
                    "contract_error_code": getattr(e, "raw_code", None),
                    "contract_error": e.error.name if isinstance(e, VaultContractError) and e.error else None,
                    "details": e.details,
                }
            )
            await db.flush()
            log.warning("tx/submit rejected pending=%s: %s", pending.id, e.message)
            return await _out(db, pending, None, None)
        except StellarError as e:
            if e.code == "try_again_later":
                pending.status = PendingTxStatus.built  # nothing was accepted; the app may retry the same XDR
                await db.flush()
            raise
        pending.tx_hash = tx_hash
        await db.flush()
    res = await soroban.poll_tx(tx_hash, timeout=settings.tx_submit_timeout_seconds)
    applied = await apply_tx_result(ctx, pending, res, actor_user_id=user.id)
    log.info("tx/submit pending=%s kind=%s hash=%s -> %s", pending.id, pending.kind.value, tx_hash[:8], res.status)
    return await _out(db, pending, res, applied)


async def get_pending(db: AsyncSession, settings: Settings, soroban: Any, user: User, pending_id: uuid.UUID) -> PendingTransaction:
    """`GET /tx/{pending_id}`: the row, refreshed from RPC when it is still `submitted`."""
    pending = await _owned_pending(db, user, pending_id)
    now = now_utc()
    if pending.status is PendingTxStatus.built and pending.expires_at <= now:
        pending.status = PendingTxStatus.expired
        pending.result = {"status": "EXPIRED", "reason": "not_signed_in_time"}
        await db.flush()
    elif pending.status is PendingTxStatus.submitted and pending.tx_hash:
        try:
            res = await soroban.get_transaction(pending.tx_hash)
        except StellarError as e:
            log.warning("get_pending %s: rpc unavailable: %s", pending.id, e.message)
            return pending
        if not res.pending:
            await apply_tx_result(IndexContext(db, settings, soroban), pending, res, actor_user_id=pending.user_id)
    return pending


__all__ = ["get_pending", "submit_signed"]
