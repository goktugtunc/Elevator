"""Admin I/O models (X-Admin-Key protected endpoints)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import AgreementStatus, MarketCategory, UserRole
from app.schemas.common import Amount, ORMModel
from app.schemas.users import MeOut

AdminContractFunction = Literal["set_token", "set_paused", "set_fees", "set_router", "set_settle_slippage"]


class IndexerStateOut(ORMModel):
    key: str
    cursor: str | None = None
    ledger: int | None = None
    updated_at: datetime


class AdminStatsOut(BaseModel):
    users_total: int
    users_by_role: dict[str, int]
    users_active: int
    listings_by_status: dict[str, int]
    offers_by_status: dict[str, int]
    agreements_by_status: dict[str, int]
    managed_capital_active: Amount  # sum of principal of active agreements (base asset units, mixed assets)
    trades_total: int
    pending_transactions_by_status: dict[str, int]
    anchor_transactions_by_status: dict[str, int]
    notifications_unread: int
    assets_total: int
    assets_onchain_allowed: int
    indexer: list[IndexerStateOut]
    vault_contract_id: str | None = None
    network: str
    generated_at: datetime


class AdminUserOut(MeOut):
    pass


class AdminUserUpdateIn(BaseModel):
    role: UserRole | None = None
    is_active: bool | None = None
    is_admin: bool | None = None


class AdminAssetCreateIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    contract_id: str = Field(min_length=56, max_length=56, description="C... SAC / token contract id")
    code: str = Field(pattern=r"^[A-Za-z0-9]{1,12}$")
    issuer: str | None = Field(default=None, description="G... issuer for classic assets; null for XLM / pure tokens")
    name: str = Field(min_length=1, max_length=60)
    icon_url: str | None = Field(default=None, max_length=500)
    category: MarketCategory = MarketCategory.crypto
    decimals: int = Field(default=7, ge=0, le=18)
    is_active: bool = True
    is_base_allowed: bool = False
    network: Literal["testnet", "public"] | None = Field(default=None, description="defaults to STELLAR_NETWORK")


class AdminAssetUpdateIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=60)
    icon_url: str | None = Field(default=None, max_length=500)
    category: MarketCategory | None = None
    is_active: bool | None = None
    is_base_allowed: bool | None = None


class AssetSyncRow(BaseModel):
    asset_id: uuid.UUID
    code: str
    contract_id: str
    onchain_allowed: bool | None = None
    onchain_is_base: bool | None = None
    changed: bool = False
    error: str | None = None


class AssetSyncOut(BaseModel):
    vault_contract_id: str
    checked: int
    changed: int
    rows: list[AssetSyncRow]


class AdminAgreementOut(ORMModel):
    id: uuid.UUID
    onchain_id: int | None = None
    offer_id: uuid.UUID | None = None
    listing_id: uuid.UUID | None = None
    customer_id: uuid.UUID
    trader_id: uuid.UUID
    base_asset_id: uuid.UUID
    principal: Amount
    duration_secs: int
    commission_bps: int
    max_drawdown_bps: int
    status: AgreementStatus
    proposer_role: UserRole
    created_tx: str | None = None
    activate_tx: str | None = None
    cancel_tx: str | None = None
    settle_tx: str | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    current_value: Amount | None = None
    value_updated_at: datetime | None = None
    final_value: Amount | None = None
    profit: Amount | None = None
    trader_fee: Amount | None = None
    platform_fee: Amount | None = None
    customer_payout: Amount | None = None
    settled_at: datetime | None = None
    last_event_ledger: int | None = None
    created_at: datetime
    updated_at: datetime


class IndexerStatusOut(BaseModel):
    states: list[IndexerStateOut]
    latest_ledger: int | None = None
    lag_ledgers: int | None = None  # latest_ledger - vault_events.ledger
    vault_contract_id: str | None = None
    rpc_error: str | None = None


class IndexerResetIn(BaseModel):
    key: str = Field(default="vault_events", max_length=64)
    ledger: int | None = Field(default=None, ge=0, description="restart from this ledger (null = delete the row)")
    cursor: str | None = Field(default=None, max_length=128)


# --- contract admin transactions ----------------------------------------------------------------------------


class SetTokenIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    token: str = Field(description="asset uuid or C... token contract id")
    allowed: bool = True
    is_base: bool = False


class SetPausedIn(BaseModel):
    paused: bool


class SetFeesIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    platform_fee_bps: int = Field(ge=0, le=1_000)
    fee_recipient: str | None = Field(default=None, description="G... (default: platform account)")


class SetRouterIn(BaseModel):
    router: str = Field(min_length=56, max_length=56)


class SetSettleSlippageIn(BaseModel):
    bps: int = Field(ge=0, le=5_000)


class AdminTxOut(BaseModel):
    function: str
    args: dict[str, Any]
    contract_id: str
    source: str  # the admin (platform) account that must sign
    unsigned_xdr: str
    network_passphrase: str
    tx_hash: str | None = Field(default=None, description="hash of the envelope (signing does not change it)")
    expires_at: datetime | None = None
    note: str = "Sign with the platform secret and POST /admin/contract/tx/submit {signed_xdr}"


class AdminTxSubmitIn(BaseModel):
    signed_xdr: str = Field(min_length=1)


class AdminTxSubmitOut(BaseModel):
    tx_hash: str
    status: str  # SUCCESS | FAILED | NOT_FOUND
    ledger: int | None = None
    error: str | None = None
    contract_error_code: int | None = None  # vault #[contracterror] code when the failure was one
