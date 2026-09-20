"""`anchor_sync` worker job (DESIGN §3.1 step 5): every `settings.anchor_sync_seconds` refresh the status
of every non-terminal anchor transaction through the user's stored SEP-10 session, mirror the SEP-24
state machine into `anchor_transactions` and notify the user on the transitions that matter
("Yatırma işlemi tamamlandı / Çekim tamamlandı", pending_trust, pending_user, ...).

The backend cannot re-run SEP-10 without the user's signature, so when a session is missing, expired or
rejected (401/403) the transaction is flagged `needs_reauth` (in `raw`) and the user is notified once;
the next `POST /anchor/auth/token` clears the flag through the regular sync.

`run_anchor_sync_once(db, settings)` flushes only (tests commit); `anchor_sync_loop` owns its sessions.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import AnchorTransaction, AnchorTxStatus, NotificationCategory, User
from app.services import anchor as anchor_service
from app.services.anchor import AnchorAuthRequiredError, AnchorClient, AnchorError
from app.services.notifications import notify

log = logging.getLogger(__name__)

TERMINAL = tuple(s.value for s in AnchorTxStatus if s.is_terminal)


@dataclass
class AnchorSyncResult:
    checked: int = 0
    updated: int = 0
    failed: int = 0
    reauth_needed: int = 0
    users: int = 0
    errors: list[str] = field(default_factory=list)


async def _flag_reauth(db: AsyncSession, rows: list[AnchorTransaction], reason: str) -> int:
    """Mark the rows `needs_reauth` (idempotent) and notify the user once per batch. Returns new flags."""
    newly = 0
    for tx in rows:
        raw = dict(tx.raw or {})
        if raw.get("needs_reauth"):
            continue
        raw["needs_reauth"] = True
        raw["needs_reauth_reason"] = reason
        raw["needs_reauth_at"] = datetime.now(UTC).isoformat()
        tx.raw = raw
        anchor_service.touch(tx)
        newly += 1
    if newly:
        first = rows[0]
        await notify(
            db,
            first.user_id,
            "anchor_reauth_required",
            "Anchor session expired",
            "Sign in to the anchor again with your wallet to keep tracking your deposits and withdrawals.",
            {"anchor_domain": first.anchor_domain, "count": len(rows), "reason": reason, "action": "reauth"},
            category=NotificationCategory.wallet,
        )
        await db.flush()
    return newly


async def _clear_reauth(rows: list[AnchorTransaction]) -> None:
    for tx in rows:
        raw = tx.raw if isinstance(tx.raw, dict) else {}
        if raw.get("needs_reauth"):
            raw = dict(raw)
            for key in ("needs_reauth", "needs_reauth_reason", "needs_reauth_at"):
                raw.pop(key, None)
            tx.raw = raw
            anchor_service.touch(tx)


async def run_anchor_sync_once(
    db: AsyncSession, settings: Settings, *, client: AnchorClient | None = None, limit: int = 200
) -> AnchorSyncResult:
    """One pass over every non-terminal anchor transaction of the configured anchor. Flush only."""
    result = AnchorSyncResult()
    if not settings.anchor_enabled:
        return result
    client = client or anchor_service.get_anchor_client()
    rows = list(
        (
            await db.execute(
                select(AnchorTransaction)
                .where(AnchorTransaction.anchor_domain == client.domain, AnchorTransaction.status.not_in(TERMINAL))
                .order_by(AnchorTransaction.created_at.asc())
                .limit(limit)
            )
        ).scalars().all()
    )
    if not rows:
        return result
    by_user: dict[uuid.UUID, list[AnchorTransaction]] = defaultdict(list)
    for tx in rows:
        by_user[tx.user_id].append(tx)
    result.users = len(by_user)
    for user_id, txs in by_user.items():
        user = await db.get(User, user_id)
        if user is None:
            continue
        try:
            _, token = await anchor_service.require_token(db, settings, user, client.domain)
        except AnchorAuthRequiredError as e:
            result.reauth_needed += await _flag_reauth(db, txs, e.code)
            continue
        await _clear_reauth(txs)
        for tx in txs:
            result.checked += 1
            try:
                if await anchor_service.refresh_transaction(db, client, token, tx):
                    result.updated += 1
            except AnchorAuthRequiredError as e:
                await anchor_service.drop_session(db, await anchor_service.get_session(db, user.id, client.domain))
                result.reauth_needed += await _flag_reauth(db, txs, e.code)
                break
            except AnchorError as e:
                result.failed += 1
                result.errors.append(f"{tx.anchor_tx_id}: {e.message}")
                log.warning("anchor_sync: %s failed: %s", tx.anchor_tx_id, e.message)
    await db.flush()
    log.info(
        "anchor_sync: users=%d checked=%d updated=%d failed=%d reauth=%d",
        result.users, result.checked, result.updated, result.failed, result.reauth_needed,
    )
    return result


async def anchor_sync_loop(settings: Settings, *, stop: asyncio.Event | None = None) -> None:
    """Forever loop for `python -m app.worker.main`: one pass, commit, sleep `anchor_sync_seconds`."""
    from app.db.session import get_session_factory

    factory = get_session_factory()
    while stop is None or not stop.is_set():
        try:
            async with factory() as db:
                try:
                    await run_anchor_sync_once(db, settings)
                    await db.commit()
                except Exception:
                    await db.rollback()
                    raise
        except Exception:  # noqa: BLE001 - the loop must survive anchor / db hiccups
            log.exception("anchor_sync pass failed")
        if stop is None:
            await asyncio.sleep(settings.anchor_sync_seconds)
        else:
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.anchor_sync_seconds)
            except TimeoutError:
                pass


__all__ = ["AnchorSyncResult", "anchor_sync_loop", "run_anchor_sync_once"]
