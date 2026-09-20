"""indexer_state — key/value cursor storage for the event indexer and other workers."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class IndexerState(Base):
    __tablename__ = "indexer_state"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)  # e.g. "vault_events"
    cursor: Mapped[str | None] = mapped_column(String(128), nullable=True)  # getEvents paging cursor
    ledger: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # last processed ledger
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
