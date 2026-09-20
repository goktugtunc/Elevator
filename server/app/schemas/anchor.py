"""Anchor (SEP-1 / SEP-10 / SEP-24 / SEP-12) I/O models — Cüzdan → Yatır / Çek (DESIGN §3, Figma 8c).

Amounts are decimal strings end to end (SEP-24 gotcha #6). `asset_code` uses the anchor's codes
(`native` for XLM, otherwise the issued code) and is always paired with `asset_issuer` for issued assets.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError

from app.models.enums import AnchorTxKind
from app.schemas.common import Amount, AmountIn

#: What the mobile app should do for a given SEP-24 status (state machine, gotcha #8).
AnchorAction = Literal["open_interactive", "send_payment", "add_trustline", "wait", "none", "retry"]
CallbackMode = Literal["postMessage"]


# --- discovery / info -------------------------------------------------------------------------------


class AnchorAssetOut(BaseModel):
    code: str = Field(description="anchor asset code: `native` for XLM, otherwise the issued code")
    display_code: str = Field(description="what the UI shows (`XLM` for native)")
    issuer: str | None = None
    needs_trustline: bool = Field(description="issued asset: the account needs a trustline before a deposit")
    deposit_enabled: bool = False
    deposit_min: Amount | None = None
    deposit_max: Amount | None = None
    deposit_fee_fixed: Amount | None = None
    deposit_fee_percent: Amount | None = None
    withdraw_enabled: bool = False
    withdraw_min: Amount | None = None
    withdraw_max: Amount | None = None
    withdraw_fee_fixed: Amount | None = None
    withdraw_fee_percent: Amount | None = None
    description: str | None = None


class AnchorFeaturesOut(BaseModel):
    account_creation: bool = False
    claimable_balances: bool = False


class AnchorSessionOut(BaseModel):
    """State of the user's SEP-10 session with the anchor. The anchor JWT itself is never returned."""

    anchor_domain: str
    authenticated: bool
    account: str | None = None
    expires_at: datetime | None = None


class AnchorInfoOut(BaseModel):
    enabled: bool
    home_domain: str
    network_passphrase: str | None = None
    signing_key: str | None = None
    web_auth_endpoint: str | None = None
    web_auth_domain: str | None = None
    transfer_server_sep24: str | None = None
    kyc_server: str | None = None
    features: AnchorFeaturesOut = Field(default_factory=AnchorFeaturesOut)
    assets: list[AnchorAssetOut] = Field(default_factory=list)
    lang: str
    session: AnchorSessionOut | None = None
    fetched_at: datetime | None = None
    error: str | None = Field(default=None, description="set when the anchor could not be reached")


# --- SEP-10 -----------------------------------------------------------------------------------------


class ChallengeIn(BaseModel):
    memo: int | None = Field(default=None, ge=0, le=2**64 - 1, description="optional SEP-10 ID memo")


class ChallengeOut(BaseModel):
    """A verified SEP-10 challenge. Sign it with the wallet key and POST it to /anchor/auth/token —
    NEVER submit it to the network (sequence number is 0)."""

    transaction: str = Field(description="base64 XDR of the anchor-signed challenge (verified by the backend)")
    network_passphrase: str
    home_domain: str
    web_auth_domain: str
    signing_key: str = Field(description="anchor SIGNING_KEY that signed the challenge")
    account: str
    expires_at: datetime
    instructions: str = "Sign with the wallet key and POST {signed_xdr} to /anchor/auth/token. Do not submit."


class TokenIn(BaseModel):
    signed_xdr: str = Field(
        min_length=1, validation_alias=AliasChoices("signed_xdr", "transaction"), description="user-signed challenge XDR"
    )


# --- SEP-24 interactive ------------------------------------------------------------------------------


class InteractiveIn(BaseModel):
    asset_code: str = Field(min_length=1, max_length=12, description="`native`/`XLM` or an issued code")
    asset_issuer: str | None = Field(default=None, min_length=56, max_length=56)
    amount: AmountIn | None = None
    lang: str | None = Field(default=None, min_length=2, max_length=8)
    callback: CallbackMode | None = Field(
        default=None, description="`postMessage` appends callback=postMessage to the interactive url"
    )
    claimable_balance_supported: bool = Field(
        default=False, description="deposit: the wallet can claim claimable balances (only useful when /info allows)"
    )
    skip_trustline_check: bool = Field(
        default=False, description="deposit: start even when the account has no trustline (anchor -> pending_trust)"
    )

    @field_validator("asset_code")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class InstructionOut(BaseModel):
    """One line of the anchor's off-chain instructions (SEP-6 ``instructions``)."""

    name: str
    value: str
    description: str = ""


class InteractiveOut(BaseModel):
    """A started deposit / withdrawal.

    Two shapes, by protocol. SEP-24 gives an ``interactive_url`` the app opens in a webview and the
    anchor takes it from there. SEP-6 has no page: the anchor answers with the off-chain leg itself,
    so ``how`` / ``instructions`` (deposit) or ``deposit_account`` + ``memo`` (withdrawal) carry
    everything the user needs, and the app renders it.
    """

    id: uuid.UUID
    anchor_tx_id: str
    kind: AnchorTxKind
    status: str
    type: str = "interactive_customer_info_needed"
    interactive_url: str | None = Field(
        default=None, description="SEP-24 only: open in a system webview / popup, never an iframe"
    )
    asset_code: str
    asset_issuer: str | None = None
    amount: Amount | None = None
    action: AnchorAction
    action_label: str
    # --- SEP-6 -------------------------------------------------------------
    how: str | None = Field(default=None, description="SEP-6 deposit: instructions in one sentence")
    instructions: list[InstructionOut] = Field(default_factory=list, description="SEP-6 deposit: the same, as rows")
    deposit_account: str | None = Field(default=None, description="SEP-6 withdrawal: pay this account")
    memo: str | None = Field(default=None, description="SEP-6 withdrawal: exactly this memo, or the money is lost")
    memo_type: str | None = None
    eta_seconds: int | None = None
    fee_percent: Amount | None = None
    note: str | None = Field(default=None, description="anchor's own extra_info message")


class AnchorTransactionOut(BaseModel):
    id: uuid.UUID
    anchor_domain: str
    anchor_tx_id: str
    kind: AnchorTxKind
    asset_code: str
    asset_issuer: str | None = None
    amount_in: Amount | None = None
    amount_out: Amount | None = None
    amount_fee: Amount | None = None
    status: str
    status_label: str
    is_terminal: bool
    action: AnchorAction
    action_label: str
    needs_reauth: bool = False
    interactive_url: str | None = None
    more_info_url: str | None = None
    withdraw_anchor_account: str | None = None
    withdraw_memo: str | None = None
    withdraw_memo_type: str | None = None
    stellar_tx_hash: str | None = None
    external_tx_id: str | None = None
    message: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class AnchorTransactionListOut(BaseModel):
    items: list[AnchorTransactionOut]
    total: int
    synced: bool = Field(description="false when the anchor could not be polled in this request")
    auth_required: bool = Field(default=False, description="true: run /anchor/auth/challenge + token again")
    sync_error: str | None = None


# --- SEP-12 -----------------------------------------------------------------------------------------


class KycIn(BaseModel):
    fields: dict[str, str] = Field(description="SEP-9 fields (first_name, last_name, email_address, ...)")
    type: str | None = Field(default=None, max_length=64, description="anchor customer type when required")
    customer_id: str | None = Field(default=None, max_length=128, description="existing SEP-12 customer id")

    @field_validator("fields")
    @classmethod
    def _non_empty(cls, v: dict[str, str]) -> dict[str, str]:
        clean = {k.strip(): str(val) for k, val in v.items() if k.strip()}
        if not clean:
            raise PydanticCustomError("fields_empty", "fields must not be empty")
        return clean


class KycOut(BaseModel):
    customer_id: str | None = None
    status: str | None = None
    fields: dict[str, Any] | None = None
    provided_fields: dict[str, Any] | None = None
    message: str | None = None


__all__ = [
    "AnchorAction",
    "AnchorAssetOut",
    "AnchorFeaturesOut",
    "AnchorInfoOut",
    "AnchorSessionOut",
    "AnchorTransactionListOut",
    "AnchorTransactionOut",
    "ChallengeIn",
    "ChallengeOut",
    "InteractiveIn",
    "InstructionOut",
    "InteractiveOut",
    "KycIn",
    "KycOut",
    "TokenIn",
]
