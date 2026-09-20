"""Wallet (Figma 8c Cüzdan) I/O models: balances, TL equivalents, missing trustlines, recent movements,
deposit info and the unsigned classic payment / trustline builders (DESIGN §2.3 Wallet, §3.2)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator
from pydantic_core import PydanticCustomError

from app.schemas.agreements import AssetBriefOut
from app.schemas.common import Amount, AmountIn

MovementKind = Literal[
    "payment_in",
    "payment_out",
    "create_account",
    "agreement_escrow",
    "agreement_payout",
    "agreement_refund",
    "anchor_deposit",
    "anchor_withdraw",
]
MovementRef = Literal["payment", "agreement", "anchor"]
BalanceSource = Literal["horizon", "soroban"]


class WalletBalanceOut(BaseModel):
    asset: AssetBriefOut | None = Field(default=None, description="allow-listed asset row; null for other trustlines")
    code: str
    issuer: str | None = None
    contract_id: str | None = None
    balance: Amount
    available: Amount = Field(description="balance minus selling liabilities (classic) / balance (Soroban)")
    limit: Amount | None = None
    value_try: Amount | None = Field(default=None, description="TL equivalent when a USD price is known")
    source: BalanceSource
    is_anchor_asset: bool = False
    is_base_allowed: bool = False


class MissingTrustlineOut(BaseModel):
    asset_code: str
    issuer: str
    asset_id: uuid.UUID | None = None
    reason: str = Field(description="anchor_deposit | account_not_funded")
    build_endpoint: str = "/wallet/tx/trustline"


class MovementOut(BaseModel):
    id: str
    kind: MovementKind
    direction: Literal["in", "out", "none"]
    title: str
    asset_code: str
    asset_issuer: str | None = None
    amount: Amount | None = None
    value_try: Amount | None = None
    counterparty: str | None = None
    memo: str | None = None
    tx_hash: str | None = None
    status: str | None = None
    at: datetime
    ref_type: MovementRef
    ref_id: str | None = None


class WalletFxOut(BaseModel):
    rate: Amount = Field(description="TRY per 1 USD")
    source: str
    stale: bool = False


class WalletOut(BaseModel):
    address: str
    network: str
    funded: bool = Field(description="false until the account exists on the ledger (friendbot on testnet)")
    balances: list[WalletBalanceOut]
    total_try: Amount | None = None
    fx: WalletFxOut | None = None
    missing_trustlines: list[MissingTrustlineOut] = Field(default_factory=list)
    movements: list[MovementOut] = Field(default_factory=list)
    anchor_enabled: bool
    anchor_home_domain: str
    friendbot_url: str | None = None
    updated_at: datetime


class DepositInfoAssetOut(BaseModel):
    code: str
    display_code: str
    issuer: str | None = None
    needs_trustline: bool
    has_trustline: bool | None = Field(default=None, description="null when the account does not exist yet")
    deposit_enabled: bool = False
    deposit_min: Amount | None = None
    deposit_max: Amount | None = None


class DepositInfoOut(BaseModel):
    address: str
    network: str
    network_passphrase: str
    funded: bool | None = None
    friendbot_url: str | None = Field(default=None, description="testnet only: GET this to fund the account")
    pay_uri: str = Field(description="SEP-7 `web+stellar:pay?destination=...` for QR codes")
    instructions: list[str]
    anchor_enabled: bool
    anchor_home_domain: str
    anchor_assets: list[DepositInfoAssetOut] = Field(default_factory=list)
    anchor_protocol: str | None = Field(
        default=None,
        description="sep24 (anchor opens its own web page) or sep6 (the anchor answers with instructions)",
    )
    anchor_error: str | None = None


class WalletPaymentIn(BaseModel):
    to: str = Field(min_length=56, max_length=69, description="destination G... (or M...) account")
    asset_id: uuid.UUID | None = None
    asset_code: str | None = Field(default=None, min_length=1, max_length=12)
    asset_issuer: str | None = Field(default=None, min_length=56, max_length=56)
    amount: AmountIn
    memo: str | None = Field(default=None, max_length=64)
    memo_type: Literal["text", "id", "hash"] = "text"

    @model_validator(mode="after")
    def _asset_given(self) -> WalletPaymentIn:
        if self.asset_id is None and not self.asset_code:
            raise PydanticCustomError("asset_required", "asset_id or asset_code is required")
        return self


class TrustlineIn(BaseModel):
    asset_id: uuid.UUID | None = None
    asset_code: str | None = Field(default=None, min_length=1, max_length=12)
    issuer: str | None = Field(default=None, min_length=56, max_length=56)
    limit: AmountIn | None = Field(default=None, description="omit for the maximum trustline limit")

    @model_validator(mode="after")
    def _asset_given(self) -> TrustlineIn:
        if self.asset_id is None and not (self.asset_code and self.issuer):
            raise PydanticCustomError("asset_required", "asset_id or asset_code + issuer is required")
        return self


__all__ = [
    "DepositInfoAssetOut",
    "DepositInfoOut",
    "MissingTrustlineOut",
    "MovementKind",
    "MovementOut",
    "TrustlineIn",
    "WalletBalanceOut",
    "WalletFxOut",
    "WalletOut",
    "WalletPaymentIn",
]
