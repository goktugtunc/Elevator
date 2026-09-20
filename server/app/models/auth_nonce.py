"""auth_nonces — single-use nonce for the message-signature login flow (kept from the previous design)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDPrimaryKeyMixin


class AuthNonce(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "auth_nonces"

    public_key: Mapped[str] = mapped_column(String(56), nullable=False, index=True)
    nonce: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
