"""Public client configuration (`GET /config`) and the USD->TRY rate (`GET /fx`).

Mounted under the API prefix by app.main. NOTE for integration: app/routers/meta.py also serves a
minimal `/api/v1/config`; list "config" BEFORE "meta" in ROUTER_MODULES (or drop the meta handler)
so this richer response wins — Starlette matches routes in registration order.
"""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.api_deps import DB, SettingsDep, SorobanDep
from app.core.config import Settings
from app.models import Asset
from app.schemas.assets import (
    AnchorConfigOut,
    AssetOut,
    AuthConfigOut,
    ConfigOut,
    ContractConfigOut,
    ContractLimits,
    FxConvertOut,
    FxOut,
)
from app.services import fx as fx_service
from app.services.admin import contract_config, vault_id
from app.services.amounts import quantize
from app.services.auth import LOGIN_MESSAGE_PREFIX
from app.services.stellar.admin_tx import platform_public_key
from app.services.stellar.sep10 import server_public_key

router = APIRouter(tags=["config"])

API_VERSION = "1.0.0"
CONTRACT_CONFIG_TTL = 60.0
_contract_cache: tuple[float, dict[str, Any] | None, str | None] = (0.0, None, None)


def web_auth_endpoint(settings: Settings) -> str:
    return f"https://{settings.web_auth_domain}{settings.api_prefix.rstrip('/')}/auth/sep10"


async def _contract(soroban: Any, settings: Settings) -> tuple[dict[str, Any] | None, str | None]:
    """Live vault config (cached 60 s in-process so app start-ups do not hammer RPC)."""
    global _contract_cache
    if not vault_id(soroban, settings):
        return None, "VAULT_CONTRACT_ID not configured"
    ts, cfg, err = _contract_cache
    if cfg is not None and time.monotonic() - ts < CONTRACT_CONFIG_TTL:
        return cfg, err
    cfg, err = await contract_config(soroban)
    if cfg is not None:
        _contract_cache = (time.monotonic(), cfg, err)
    return cfg, err


def reset_contract_cache() -> None:
    """Test hook."""
    global _contract_cache
    _contract_cache = (0.0, None, None)


@router.get("/config", response_model=ConfigOut)
async def public_config(db: DB, settings: SettingsDep, soroban=SorobanDep) -> ConfigOut:
    """Everything the mobile client needs at start-up: network, endpoints, vault contract id, Soroswap
    router, allow-listed tokens, fee bps (live from the contract), anchor + auth parameters."""
    assets = (
        await db.execute(
            select(Asset)
            .where(Asset.network == settings.stellar_network, Asset.is_active.is_(True))
            .order_by(Asset.is_base_allowed.desc(), Asset.code.asc())
        )
    ).scalars().all()
    cfg, err = await _contract(soroban, settings)
    contract = None
    if cfg is not None:
        try:
            contract = ContractConfigOut(**cfg)
        except Exception as e:  # unexpected gateway shape: report, do not fail the whole config
            err = f"unexpected contract config shape: {e.__class__.__name__}"
    return ConfigOut(
        version=API_VERSION,
        network=settings.stellar_network,
        network_passphrase=settings.network_passphrase,
        horizon_url=settings.effective_horizon_url,
        soroban_rpc_url=settings.effective_rpc_url,
        friendbot_url=settings.effective_friendbot_url,
        home_domain=settings.home_domain,
        web_auth_domain=settings.web_auth_domain,
        web_auth_endpoint=web_auth_endpoint(settings),
        signing_key=server_public_key(settings),
        platform_account=platform_public_key(settings),
        api_prefix=settings.api_prefix,
        vault_contract_id=vault_id(soroban, settings),
        soroswap_router_id=settings.effective_soroswap_router_id,
        soroswap_api_url=settings.soroswap_api_url,
        default_base_asset_code=settings.default_base_asset_code,
        platform_fee_bps=contract.platform_fee_bps if contract else None,
        settle_slippage_bps=contract.settle_slippage_bps if contract else settings.settle_slippage_bps,
        default_trade_slippage_bps=settings.default_trade_slippage_bps,
        tx_submit_timeout_seconds=settings.tx_submit_timeout_seconds,
        limits=ContractLimits(),
        contract=contract,
        contract_error=err,
        anchor=AnchorConfigOut(
            enabled=settings.anchor_enabled,
            home_domain=settings.anchor_home_domain,
            assets=settings.anchor_asset_list,
            lang=settings.anchor_lang,
        ),
        assets=[AssetOut.model_validate(a) for a in assets],
        auth=AuthConfigOut(
            login_message_prefix=LOGIN_MESSAGE_PREFIX,
            auth_nonce_ttl_seconds=settings.auth_nonce_ttl_seconds,
            access_token_ttl_seconds=settings.access_token_ttl_seconds,
            sep10_challenge_timeout=settings.sep10_challenge_timeout,
        ),
        fx_cache_seconds=settings.fx_cache_seconds,
        usd_prices=fx_service.usd_price_map(sorted({a.code for a in assets})),
    )


@router.get("/fx", response_model=FxOut)
async def fx(db: DB, settings: SettingsDep) -> FxOut:
    """USD->TRY (cached `fx_cache_seconds`; primary/secondary sources; persisted fallback) plus the
    indicative USD price map used for TL display."""
    rate = await fx_service.get_usd_try(settings, db)
    codes = (await db.execute(select(Asset.code).where(Asset.network == settings.stellar_network).distinct())).scalars()
    return FxOut(
        rate=quantize(rate.rate),
        source=rate.source,
        fetched_at=rate.fetched_at,
        stale=rate.stale,
        cache_seconds=settings.fx_cache_seconds,
        usd_prices=fx_service.usd_price_map(sorted(set(codes) | set(fx_service.INDICATIVE_USD_PRICES))),
        note=fx_service.INDICATIVE_NOTE,
    )


@router.get("/fx/convert", response_model=FxConvertOut)
async def fx_convert(
    db: DB,
    settings: SettingsDep,
    amount_usd: Annotated[Decimal, Query(ge=0, decimal_places=7, max_digits=30)],
) -> FxConvertOut:
    rate = await fx_service.get_usd_try(settings, db)
    return FxConvertOut(
        amount_usd=quantize(amount_usd),
        amount_try=fx_service.to_try(amount_usd, rate),
        rate=quantize(rate.rate),
        stale=rate.stale,
    )
