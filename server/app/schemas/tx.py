"""Unsigned-transaction hand-off and submit I/O (DESIGN §2.4 mobile signing model).

Flow: `POST /agreements/{id}/tx/{action}` -> `UnsignedTxOut` (source = the caller, simulated, unsigned) ->
the app signs -> `POST /tx/submit {pending_tx_id, signed_xdr}` -> `TxSubmitOut`.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field

from app.models.enums import AgreementStatus, PendingTxKind, PendingTxStatus
from app.schemas.common import ORMModel

TxAction = Literal["open", "propose", "fund", "accept", "cancel", "settle"]
SubmitStatus = Literal["SUCCESS", "FAILED", "PENDING"]


class TxActionIn(BaseModel):
    """Optional body of `POST /agreements/{id}/tx/{action}`."""

    slippage_bps: int | None = Field(
        default=None,
        ge=0,
        le=5_000,
        description="settle only: each min_out = router quote × (1 − bps); default settings.settle_slippage_bps",
    )


class UnsignedTxOut(BaseModel):
    """What the mobile app signs. `summary` explains the transaction ("what am I signing?")."""

    pending_tx_id: uuid.UUID
    kind: PendingTxKind
    agreement_id: uuid.UUID | None = None
    unsigned_xdr: str
    network_passphrase: str
    tx_hash: str = Field(description="hash of the envelope; signing does not change it")
    source: str = Field(description="G... account that must sign (the caller)")
    expires_at: datetime
    summary: dict[str, Any]


class TxSubmitIn(BaseModel):
    pending_tx_id: uuid.UUID
    signed_xdr: str = Field(min_length=1)


class TxSubmitOut(BaseModel):
    pending_tx_id: uuid.UUID
    kind: PendingTxKind
    tx_hash: str
    status: SubmitStatus = Field(description="SUCCESS | FAILED | PENDING (not yet in a ledger after the poll window)")
    pending_status: PendingTxStatus
    ledger: int | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    contract_error: str | None = None
    contract_error_code: int | None = None
    agreement_id: uuid.UUID | None = None
    agreement_status: AgreementStatus | None = None
    onchain_id: int | None = None
    trade_id: uuid.UUID | None = None
    events: list[dict[str, Any]] = Field(default_factory=list, description="decoded vault events of the transaction")


class PendingTxOut(ORMModel):
    id: uuid.UUID
    user_id: uuid.UUID
    kind: PendingTxKind
    agreement_id: uuid.UUID | None = None
    status: PendingTxStatus
    tx_hash: str | None = None
    unsigned_xdr: str
    result: dict[str, Any] | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    submitted_at: datetime | None = None
    expires_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_expired(self) -> bool:
        if self.status is PendingTxStatus.expired:
            return True
        return self.status is PendingTxStatus.built and self.expires_at <= datetime.now(UTC)
