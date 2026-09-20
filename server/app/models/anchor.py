"""anchor_sessions + anchor_transactions — SEP-10 / SEP-24 state (DESIGN §3.2)."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, Enum, ForeignKey, Index, LargeBinary, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import AnchorTxKind, AnchorTxStatus


class AnchorSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """The anchor's SEP-10 JWT for a user, AES-GCM encrypted with POOL_KEY_ENCRYPTION_KEY
    (app.core.security.encrypt_secret, associated = user's stellar address). Never sent to the mobile."""

    __tablename__ = "anchor_sessions"
    __table_args__ = (UniqueConstraint("user_id", "anchor_domain", name="uq_anchor_sessions_user_domain"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    anchor_domain: Mapped[str] = mapped_column(String(255), nullable=False)
    account: Mapped[str] = mapped_column(String(56), nullable=False)  # G... the JWT was issued for
    jwt: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)  # ENCRYPTED blob (nonce||ciphertext)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    def is_expired(self, now: datetime) -> bool:
        return self.expires_at <= now


class AnchorTransaction(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Mirror of a SEP-24 transaction (`GET /transaction?id=`). `status` is the anchor's raw status string
    (see enums.AnchorTxStatus for the known values); `raw` keeps the last full JSON from the anchor."""

    __tablename__ = "anchor_transactions"
    __table_args__ = (
        UniqueConstraint("anchor_domain", "anchor_tx_id", name="uq_anchor_transactions_domain_tx_id"),
        Index("ix_anchor_transactions_user_created", "user_id", "created_at"),
        Index("ix_anchor_transactions_status", "status"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    anchor_domain: Mapped[str] = mapped_column(String(255), nullable=False)
    anchor_tx_id: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[AnchorTxKind] = mapped_column(Enum(AnchorTxKind, native_enum=False, length=16), nullable=False)
    asset_code: Mapped[str] = mapped_column(String(12), nullable=False)  # "native" or code
    asset_issuer: Mapped[str | None] = mapped_column(String(56), nullable=True)
    amount_in: Mapped[Decimal | None] = mapped_column(Numeric(30, 7), nullable=True)
    amount_out: Mapped[Decimal | None] = mapped_column(Numeric(30, 7), nullable=True)
    amount_fee: Mapped[Decimal | None] = mapped_column(Numeric(30, 7), nullable=True)
    status: Mapped[str] = mapped_column(
        String(40), nullable=False, default=AnchorTxStatus.incomplete.value, server_default="incomplete"
    )
    interactive_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    more_info_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # withdraw leg: the user pays the anchor with exactly this memo (SEP-24 gotcha)
    withdraw_anchor_account: Mapped[str | None] = mapped_column(String(69), nullable=True)  # G... or M...
    withdraw_memo: Mapped[str | None] = mapped_column(String(128), nullable=True)
    withdraw_memo_type: Mapped[str | None] = mapped_column(String(16), nullable=True)  # text | id | hash
    stellar_tx_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    external_tx_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")

    @property
    def is_terminal(self) -> bool:
        try:
            return AnchorTxStatus(self.status).is_terminal
        except ValueError:
            return False
