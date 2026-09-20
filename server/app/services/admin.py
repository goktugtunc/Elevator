"""Operator helpers behind the X-Admin-Key endpoints: platform stats, allow-list sync with the vault
contract (`is_token_allowed` through the Soroban gateway), live contract config, indexer status and
the vault admin transactions (built by the gateway's `build_set_token / build_set_paused /
build_set_fees` with source = the platform account; submitted with `send` + `poll_tx`)."""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import NotFoundError, StellarError, ValidationError
from app.models import (
    Agreement,
    AgreementStatus,
    AnchorTransaction,
    Asset,
    IndexerState,
    Listing,
    Notification,
    Offer,
    PendingTransaction,
    Trade,
    User,
)
from app.schemas.admin import (
    AdminStatsOut,
    AdminTxOut,
    AdminTxSubmitOut,
    AssetSyncOut,
    AssetSyncRow,
    IndexerStateOut,
    IndexerStatusOut,
)
from app.services.amounts import quantize
from app.services.stellar import admin_tx
from app.services.stellar.admin_tx import is_valid_contract_id, platform_public_key
from app.services.stellar.sep10 import is_valid_public_key

log = logging.getLogger(__name__)

VAULT_EVENTS_KEY = "vault_events"


def _enum_counts(rows: list[tuple[Any, int]]) -> dict[str, int]:
    return {str(getattr(k, "value", k)): int(v) for k, v in rows}


async def _count_by(db: AsyncSession, column: Any) -> dict[str, int]:
    return _enum_counts((await db.execute(select(column, func.count()).group_by(column))).all())


def vault_id(soroban: Any, settings: Settings) -> str | None:
    """The vault contract id the gateway talks to (its `vault` property; None when not configured)."""
    try:
        v = getattr(soroban, "vault", None)
    except Exception:  # the real gateway raises StellarError(vault_not_configured)
        v = None
    return (v if isinstance(v, str) and v else None) or settings.vault_contract_id


async def stats(db: AsyncSession, settings: Settings) -> AdminStatsOut:
    users_by_role = await _count_by(db, User.role)
    users_active = int(
        (await db.execute(select(func.count()).select_from(User).where(User.is_active.is_(True)))).scalar_one()
    )
    managed = (
        await db.execute(
            select(func.coalesce(func.sum(Agreement.principal), 0)).where(Agreement.status == AgreementStatus.active)
        )
    ).scalar_one()
    trades_total = int((await db.execute(select(func.count()).select_from(Trade))).scalar_one())
    unread = int(
        (
            await db.execute(select(func.count()).select_from(Notification).where(Notification.read_at.is_(None)))
        ).scalar_one()
    )
    assets_total, assets_onchain = (
        await db.execute(
            select(func.count(), func.count().filter(Asset.onchain_allowed.is_(True))).where(
                Asset.network == settings.stellar_network
            )
        )
    ).one()
    indexer_rows = (await db.execute(select(IndexerState).order_by(IndexerState.key))).scalars().all()
    return AdminStatsOut(
        users_total=sum(users_by_role.values()),
        users_by_role=users_by_role,
        users_active=users_active,
        listings_by_status=await _count_by(db, Listing.status),
        offers_by_status=await _count_by(db, Offer.status),
        agreements_by_status=await _count_by(db, Agreement.status),
        managed_capital_active=quantize(Decimal(managed or 0)),
        trades_total=trades_total,
        pending_transactions_by_status=await _count_by(db, PendingTransaction.status),
        anchor_transactions_by_status=await _count_by(db, AnchorTransaction.status),
        notifications_unread=unread,
        assets_total=int(assets_total or 0),
        assets_onchain_allowed=int(assets_onchain or 0),
        indexer=[IndexerStateOut.model_validate(r) for r in indexer_rows],
        vault_contract_id=settings.vault_contract_id,
        network=settings.stellar_network,
        generated_at=datetime.now(UTC),
    )


# --- contract reads through the gateway -------------------------------------------------------------------


def _token_info(raw: Any) -> tuple[bool, bool]:
    """Normalise the gateway's `is_token_allowed` result (contract_abi.TokenInfo, dict or tuple)."""
    if isinstance(raw, dict):
        return bool(raw.get("allowed", False)), bool(raw.get("is_base", False))
    if isinstance(raw, tuple | list) and len(raw) >= 2:
        return bool(raw[0]), bool(raw[1])
    if hasattr(raw, "allowed"):
        return bool(raw.allowed), bool(getattr(raw, "is_base", False))
    raise StellarError(f"unexpected is_token_allowed result: {raw!r}", code="bad_gateway_result")


_CONFIG_KEYS = ("admin", "router", "platform_fee_bps", "fee_recipient", "paused", "settle_slippage_bps")


def _config_dict(raw: Any) -> dict[str, Any]:
    d = dict(raw) if isinstance(raw, dict) else {k: getattr(raw, k) for k in _CONFIG_KEYS if hasattr(raw, k)}
    for key in ("admin", "router", "fee_recipient"):
        if key in d and not isinstance(d[key], str):
            d[key] = str(getattr(d[key], "address", d[key]))
    return d


async def contract_config(soroban: Any) -> tuple[dict[str, Any] | None, str | None]:
    """Live `get_config()` of the vault via the gateway: (config, error). Never raises."""
    fn = getattr(soroban, "get_config", None)
    if not callable(fn):
        return None, "gateway has no get_config"
    try:
        raw = await fn()
    except Exception as e:
        log.warning("contract get_config failed: %s: %s", e.__class__.__name__, str(e)[:200])
        return None, f"{e.__class__.__name__}: {str(e)[:200]}"
    if raw is None:
        return None, "contract config unavailable"
    return _config_dict(raw), None


async def sync_assets_onchain(db: AsyncSession, settings: Settings, soroban: Any) -> AssetSyncOut:
    """Mirror the vault allow-list into `assets.onchain_allowed` (network-wide, active rows first).
    `is_base_allowed` (the off-chain product flag) is reported as `onchain_is_base` but not overwritten."""
    vault = vault_id(soroban, settings)
    if not vault:
        raise StellarError("VAULT_CONTRACT_ID is not configured", code="contract_not_configured")
    fn = getattr(soroban, "is_token_allowed", None)
    if not callable(fn):
        raise StellarError("Soroban gateway has no is_token_allowed", code="gateway_unavailable")
    rows = (
        await db.execute(
            select(Asset).where(Asset.network == settings.stellar_network).order_by(Asset.is_active.desc(), Asset.code)
        )
    ).scalars().all()
    out: list[AssetSyncRow] = []
    changed = 0
    for asset in rows:
        try:
            allowed, is_base = _token_info(await fn(asset.contract_id))
        except Exception as e:
            out.append(
                AssetSyncRow(
                    asset_id=asset.id,
                    code=asset.code,
                    contract_id=asset.contract_id,
                    error=f"{e.__class__.__name__}: {str(e)[:160]}",
                )
            )
            continue
        did_change = asset.onchain_allowed != allowed
        if did_change:
            asset.onchain_allowed = allowed
            changed += 1
        out.append(
            AssetSyncRow(
                asset_id=asset.id,
                code=asset.code,
                contract_id=asset.contract_id,
                onchain_allowed=allowed,
                onchain_is_base=is_base,
                changed=did_change,
            )
        )
    if changed:
        await db.flush()
    log.info("assets sync-onchain: vault=%s checked=%d changed=%d", vault, len(rows), changed)
    return AssetSyncOut(vault_contract_id=vault, checked=len(rows), changed=changed, rows=out)


async def indexer_status(db: AsyncSession, settings: Settings, soroban: Any) -> IndexerStatusOut:
    states = (await db.execute(select(IndexerState).order_by(IndexerState.key))).scalars().all()
    latest: int | None = None
    rpc_error: str | None = None
    fn = getattr(soroban, "latest_ledger", None)
    if callable(fn):
        try:
            raw = await fn()
            latest = int(getattr(raw, "sequence", raw)) if raw is not None else None
        except Exception as e:
            rpc_error = f"{e.__class__.__name__}: {str(e)[:160]}"
    else:
        rpc_error = "gateway has no latest_ledger"
    events = next((s for s in states if s.key == VAULT_EVENTS_KEY), None)
    lag = latest - events.ledger if latest is not None and events is not None and events.ledger is not None else None
    return IndexerStatusOut(
        states=[IndexerStateOut.model_validate(s) for s in states],
        latest_ledger=latest,
        lag_ledgers=lag,
        vault_contract_id=vault_id(soroban, settings),
        rpc_error=rpc_error,
    )


async def indexer_reset(db: AsyncSession, key: str, ledger: int | None, cursor: str | None) -> IndexerStateOut | None:
    """ledger/cursor given -> upsert the row (indexer restarts from there); both null -> delete the row."""
    row = await db.get(IndexerState, key)
    if ledger is None and cursor is None:
        if row is None:
            raise NotFoundError(f"indexer_state {key!r} not found", code="indexer_state_not_found")
        await db.delete(row)
        await db.flush()
        log.info("admin deleted indexer_state %s", key)
        return None
    if row is None:
        row = IndexerState(key=key)
        db.add(row)
    row.ledger = ledger
    row.cursor = cursor
    row.updated_at = datetime.now(UTC)
    await db.flush()
    await db.refresh(row)
    log.info("admin reset indexer_state %s ledger=%s cursor=%s", key, ledger, cursor)
    return IndexerStateOut.model_validate(row)


# --- admin transactions -----------------------------------------------------------------------------------


async def resolve_token(db: AsyncSession, settings: Settings, token: str) -> str:
    """`token` is an asset uuid (row on the configured network) or a C... contract id."""
    if is_valid_contract_id(token):
        return token
    try:
        asset_id = uuid.UUID(token)
    except ValueError as e:
        raise ValidationError("token must be an asset id or a C... contract id", code="invalid_token") from e
    asset = await db.get(Asset, asset_id)
    if asset is None or asset.network != settings.stellar_network:
        raise NotFoundError("Asset not found", code="asset_not_found")
    return asset.contract_id


async def build_admin_tx(settings: Settings, soroban: Any, function: str, args: dict[str, Any]) -> AdminTxOut:
    """Unsigned, simulated XDR for a vault admin call with source = the platform account (the admin's
    single signature also authorises the invocation). set_token/set_paused/set_fees go through the
    gateway builders; the remaining admin functions fall back to the direct ContractClient builder."""
    if function not in admin_tx.ADMIN_FUNCTIONS:
        raise ValidationError(f"unknown admin function {function}", code="unknown_function")
    if "fee_recipient" in args:
        if not args["fee_recipient"]:
            args["fee_recipient"] = platform_public_key(settings)
        elif not is_valid_public_key(args["fee_recipient"]) and not is_valid_contract_id(args["fee_recipient"]):
            raise ValidationError("fee_recipient must be a G... or C... address", code="invalid_address")
    admin_tx.encode_args(function, args)  # argument validation (types / ranges) before touching RPC
    source = platform_public_key(settings)

    if function == "set_token":
        unsigned = await soroban.build_set_token(source, args["token"], args["allowed"], args["is_base"])
    elif function == "set_paused":
        unsigned = await soroban.build_set_paused(source, args["paused"])
    elif function == "set_fees":
        unsigned = await soroban.build_set_fees(source, args["platform_fee_bps"], args["fee_recipient"])
    else:
        builder = getattr(soroban, f"build_{function}", None)
        if callable(builder):
            unsigned = await builder(source, **args)
        else:
            unsigned = await admin_tx.build_admin_invoke_xdr(settings, function, args, source)
    xdr = unsigned if isinstance(unsigned, str) else unsigned.xdr
    log.info("admin tx built fn=%s args=%s source=%s", function, args, source)
    return AdminTxOut(
        function=function,
        args=args,
        contract_id=vault_id(soroban, settings) or "",
        source=source,
        unsigned_xdr=xdr,
        network_passphrase=settings.network_passphrase,
        tx_hash=getattr(unsigned, "hash", None) or None,
        expires_at=getattr(unsigned, "expires_at", None),
    )


async def submit_admin_tx(settings: Settings, soroban: Any, signed_xdr: str) -> AdminTxSubmitOut:
    """Send the platform-signed envelope through RPC and poll it (gateway `send` + `poll_tx`)."""
    tx_hash = await soroban.send(signed_xdr)
    res = await soroban.poll_tx(tx_hash, timeout=settings.tx_submit_timeout_seconds)
    out = AdminTxSubmitOut(
        tx_hash=getattr(res, "hash", None) or tx_hash,
        status=str(getattr(res, "status", "NOT_FOUND")),
        ledger=getattr(res, "ledger", None),
        error=getattr(res, "error", None),
        contract_error_code=getattr(res, "contract_error_code", None),
    )
    log.info("admin tx submitted hash=%s status=%s", out.tx_hash, out.status)
    return out
