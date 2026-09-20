"""Application settings (environment driven).

All secrets come from the environment / .env file. Nothing here is hard-coded
for a specific deployment except sensible testnet defaults.
"""
from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015"

# Soroswap router contract ids (DESIGN §1.8)
SOROSWAP_ROUTER_TESTNET = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
SOROSWAP_ROUTER_PUBLIC = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- app -------------------------------------------------------------
    app_name: str = "Elevator API"
    app_env: Literal["dev", "test", "prod"] = "prod"
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = ["*"]
    docs_enabled: bool = True
    # Google Play herkese acik, calisan bir iletisim adresi sart; hukuki sayfalarda gosterilir.
    legal_contact_email: str | None = None

    # --- database ----------------------------------------------------------
    database_url: str = Field(
        default="postgresql+asyncpg://mobilapp:mobilapp@db:5432/mobilapp",
        description="SQLAlchemy async URL (asyncpg driver).",
    )
    db_pool_size: int = 10
    db_max_overflow: int = 10
    db_echo: bool = False

    # --- auth ------------------------------------------------------------
    jwt_secret: str = Field(min_length=32)
    jwt_algorithm: str = "HS256"
    access_token_ttl_seconds: int = 60 * 60 * 24 * 7  # 7 days (mobile friendly)
    auth_nonce_ttl_seconds: int = 300
    sep10_server_secret: str = Field(description="S... secret of the SEP-10 signing key")
    sep10_challenge_timeout: int = 900
    home_domain: str = "mobilback.yolalapp.com"
    web_auth_domain: str = "mobilback.yolalapp.com"

    admin_key: str = Field(min_length=16, description="Shared secret for X-Admin-Key admin endpoints")

    # --- stellar -----------------------------------------------------------
    stellar_network: Literal["testnet", "public"] = "testnet"
    horizon_url: str | None = None
    soroban_rpc_url: str | None = None
    friendbot_url: str | None = None
    platform_secret: str = Field(
        description="S... secret of the platform account (vault contract admin / fee recipient; signs admin txs)"
    )
    pool_key_encryption_key: str = Field(
        min_length=32, description="base64 (urlsafe) 32-byte key used to AES-GCM encrypt secrets (anchor JWTs)"
    )
    base_fee_stroops: int = 1000  # per-operation fee we are willing to pay (10x min for reliability)
    tx_timeout_seconds: int = 180
    default_slippage_pct: Decimal = Decimal("1.0")  # market swaps: dest_min = quote * (1 - slippage)
    max_slippage_pct: Decimal = Decimal("10")
    deposit_ttl_minutes: int = 30
    platform_fee_pct: Decimal = Decimal("0")  # % of profit kept by platform (0 = disabled)
    max_profit_share_pct: Decimal = Decimal("90")

    # --- soroban vault contract (DESIGN §1) -------------------------------------------------
    vault_contract_id: str | None = None  # C... of elevator_vault (deploy/contract.<network>.json)
    default_base_asset_code: str = "XLM"  # testnet: XLM (Soroswap liquidity); mainnet: USDC
    settle_slippage_bps: int = 100  # min_out = quote × (1 − bps) when the backend builds `settle`
    default_trade_slippage_bps: int = 100
    tx_submit_timeout_seconds: int = 60  # POST /tx/submit polls RPC up to this long

    # --- soroswap (eligible integration partner, DEX/Swap) ----------------------------------
    soroswap_router_id: str | None = None  # None -> per-network default (effective_soroswap_router_id)
    soroswap_api_url: str = "https://api.soroswap.finance"
    soroswap_api_key: str | None = None

    # --- anchor (SEP-1/10/24/12) — "Yatır / Çek" (DESIGN §3) --------------------------------
    anchor_enabled: bool = True
    anchor_home_domain: str = "testanchor.stellar.org"
    anchor_assets: str = "native,USDC"  # comma separated asset codes offered in the wallet
    anchor_lang: str = "tr"

    # --- FX (USD -> TRY for TL display) -----------------------------------------------------
    fx_primary_url: str = "https://open.er-api.com/v6/latest/USD"
    fx_secondary_url: str = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY"
    fx_cache_seconds: int = 600

    # --- worker intervals -------------------------------------------------------------------
    indexer_poll_seconds: int = 5
    reconcile_seconds: int = 60
    anchor_sync_seconds: int = 20

    # --- worker ------------------------------------------------------------
    worker_deposit_poll_seconds: int = 10
    worker_nav_snapshot_seconds: int = 300
    worker_withdrawal_poll_seconds: int = 10
    worker_offer_expiry_seconds: int = 60

    # --- push notifications (Expo) -------------------------------------
    expo_push_enabled: bool = False
    expo_push_url: str = "https://exp.host/--/api/v2/push/send"
    expo_access_token: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v):  # noqa: ANN001
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    # --- derived -----------------------------------------------------------
    @property
    def network_passphrase(self) -> str:
        return TESTNET_PASSPHRASE if self.stellar_network == "testnet" else PUBLIC_PASSPHRASE

    @property
    def effective_horizon_url(self) -> str:
        if self.horizon_url:
            return self.horizon_url
        return (
            "https://horizon-testnet.stellar.org"
            if self.stellar_network == "testnet"
            else "https://horizon.stellar.org"
        )

    @property
    def effective_rpc_url(self) -> str | None:
        if self.soroban_rpc_url:
            return self.soroban_rpc_url
        return "https://soroban-testnet.stellar.org" if self.stellar_network == "testnet" else None

    @property
    def effective_friendbot_url(self) -> str | None:
        if self.friendbot_url:
            return self.friendbot_url
        return "https://friendbot.stellar.org" if self.stellar_network == "testnet" else None

    @property
    def is_testnet(self) -> bool:
        return self.stellar_network == "testnet"

    @property
    def effective_soroswap_router_id(self) -> str:
        if self.soroswap_router_id:
            return self.soroswap_router_id
        return SOROSWAP_ROUTER_TESTNET if self.stellar_network == "testnet" else SOROSWAP_ROUTER_PUBLIC

    @property
    def anchor_asset_list(self) -> list[str]:
        return [a.strip() for a in self.anchor_assets.split(",") if a.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
