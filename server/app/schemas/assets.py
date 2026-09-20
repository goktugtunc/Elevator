"""Asset, FX and public-config I/O models."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, computed_field

from app.models.enums import MarketCategory
from app.schemas.common import Amount, ORMModel


class AssetOut(ORMModel):
    id: uuid.UUID
    network: str
    contract_id: str  # C... (SAC of a classic asset or a pure Soroban token)
    code: str
    issuer: str | None = None
    decimals: int = 7
    name: str
    icon_url: str | None = None
    category: MarketCategory
    is_base_allowed: bool
    is_active: bool
    onchain_allowed: bool = False
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_native(self) -> bool:
        return self.issuer is None and self.code == "XLM"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_classic(self) -> bool:
        return self.is_native or self.issuer is not None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def canonical(self) -> str:
        if self.is_native:
            return "native"
        if self.issuer is not None:
            return f"{self.code}:{self.issuer}"
        return self.contract_id


# --- FX ----------------------------------------------------------------------------------------------


class FxOut(BaseModel):
    pair: str = "USDTRY"
    base: str = "USD"
    quote: str = "TRY"
    rate: Amount
    source: str
    fetched_at: datetime
    stale: bool = False
    cache_seconds: int
    usd_prices: dict[str, Amount | None] = Field(
        default_factory=dict, description="indicative USD price per asset code (null = unknown)"
    )
    usd_prices_indicative: bool = True
    note: str


class FxConvertOut(BaseModel):
    amount_usd: Amount
    amount_try: Amount
    rate: Amount
    stale: bool


# --- public config -----------------------------------------------------------------------------------


class ContractLimits(BaseModel):
    """Constants baked into the vault contract (DESIGN §1.1)."""

    max_tokens: int = 6
    min_duration_days: int = 1
    max_duration_days: int = 3 * 365
    max_commission_bps: int = 5_000
    max_platform_fee_bps: int = 1_000
    min_drawdown_bps: int = 100
    max_drawdown_bps: int = 10_000
    max_settle_slippage_bps: int = 5_000


class ContractConfigOut(BaseModel):
    """Live `get_config()` of the vault contract (read through the Soroban gateway)."""

    admin: str
    router: str
    platform_fee_bps: int
    fee_recipient: str
    paused: bool
    settle_slippage_bps: int


class AnchorConfigOut(BaseModel):
    enabled: bool
    home_domain: str
    assets: list[str]
    lang: str


class AuthConfigOut(BaseModel):
    login_message_prefix: str
    auth_nonce_ttl_seconds: int
    access_token_ttl_seconds: int
    sep10_challenge_timeout: int


class ConfigOut(BaseModel):
    version: str
    network: str
    network_passphrase: str
    horizon_url: str
    soroban_rpc_url: str | None = None
    friendbot_url: str | None = None
    home_domain: str
    web_auth_domain: str
    web_auth_endpoint: str
    signing_key: str
    platform_account: str
    api_prefix: str
    # contract / DEX
    vault_contract_id: str | None = None
    soroswap_router_id: str
    soroswap_api_url: str
    default_base_asset_code: str
    platform_fee_bps: int | None = Field(default=None, description="live from the contract; null when unreachable")
    settle_slippage_bps: int
    default_trade_slippage_bps: int
    tx_submit_timeout_seconds: int
    limits: ContractLimits
    contract: ContractConfigOut | None = None
    contract_error: str | None = None
    # anchor (SEP-1/10/24)
    anchor: AnchorConfigOut
    # allow-listed tokens
    assets: list[AssetOut]
    auth: AuthConfigOut
    fx_cache_seconds: int
    usd_prices: dict[str, Decimal | None] = Field(default_factory=dict)
