"""pending_transactions — every unsigned XDR handed to the mobile app (DESIGN §2.4 signing model)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Enum, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKeyMixin
from app.models.enums import PendingTxKind, PendingTxStatus


class PendingTransaction(UUIDPrimaryKeyMixin, Base):
    """Lifecycle: built (unsigned XDR returned) -> submitted (POST /tx/submit sent it to RPC)
    -> success | failed (poll result / indexer). `payload` carries builder context the indexer
    needs afterwards (e.g. trade note + notify_investors, payment destination, anchor tx id)."""

    __tablename__ = "pending_transactions"
    __table_args__ = (Index("ix_pending_transactions_user_created", "user_id", "created_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[PendingTxKind] = mapped_column(Enum(PendingTxKind, native_enum=False, length=32), nullable=False)
    agreement_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("agreements.id", ondelete="SET NULL"), nullable=True, index=True
    )
    unsigned_xdr: Mapped[str] = mapped_column(Text, nullable=False)
    tx_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[PendingTxStatus] = mapped_column(
        Enum(PendingTxStatus, native_enum=False, length=32),
        nullable=False,
        default=PendingTxStatus.built,
        server_default="built",
        index=True,
    )
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # RPC getTransaction summary / error
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
