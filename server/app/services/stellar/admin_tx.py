"""Vault admin call helpers: argument encoding/validation for the admin functions and a direct
ContractClientAsync builder used for the admin functions the gateway does not wrap yet
(`set_router`, `set_settle_slippage`). Talks to the configured Soroban RPC — nothing is mocked here;
tests monkeypatch `build_admin_invoke_xdr`. Also home of `platform_public_key` / `is_valid_contract_id`.
"""
from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from stellar_sdk import Keypair, scval
from stellar_sdk.client.aiohttp_client import AiohttpClient
from stellar_sdk.contract import ContractClientAsync
from stellar_sdk.exceptions import Ed25519SecretSeedInvalidError
from stellar_sdk.strkey import StrKey
from stellar_sdk.xdr import SCVal

from app.core.config import Settings
from app.core.errors import StellarError, ValidationError

log = logging.getLogger(__name__)

# function -> ((arg name, scval kind), ...) in contract argument order (contracts/vault/src/lib.rs)
ADMIN_FUNCTIONS: dict[str, tuple[tuple[str, str], ...]] = {
    "set_token": (("token", "address"), ("allowed", "bool"), ("is_base", "bool")),
    "set_paused": (("paused", "bool"),),
    "set_fees": (("platform_fee_bps", "u32"), ("fee_recipient", "address")),
    "set_router": (("router", "address"),),
    "set_settle_slippage": (("bps", "u32"),),
}


def is_valid_contract_id(contract_id: object) -> bool:
    """True for a well-formed C... strkey."""
    if not isinstance(contract_id, str):
        return False
    try:
        return StrKey.is_valid_contract(contract_id)
    except (ValueError, TypeError):
        return False


@lru_cache(maxsize=8)
def _public_key_of(secret: str) -> str:
    try:
        return Keypair.from_secret(secret).public_key
    except (Ed25519SecretSeedInvalidError, ValueError, TypeError) as e:
        raise StellarError("invalid Stellar secret seed", code="invalid_secret") from e


def platform_public_key(settings: Settings) -> str:
    """G... of the platform account (vault contract admin / fee recipient, signs admin txs)."""
    return _public_key_of(settings.platform_secret)


def _encode(kind: str, name: str, value: Any) -> SCVal:
    if kind == "address":
        if not isinstance(value, str) or not (
            StrKey.is_valid_contract(value) or StrKey.is_valid_ed25519_public_key(value)
        ):
            raise ValidationError(f"{name} must be a C... or G... address", code="invalid_address")
        return scval.to_address(value)
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValidationError(f"{name} must be a boolean", code="invalid_argument")
        return scval.to_bool(value)
    if kind == "u32":
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 2**32 - 1:
            raise ValidationError(f"{name} must be a u32", code="invalid_argument")
        return scval.to_uint32(value)
    raise ValidationError(f"unsupported argument kind {kind}", code="invalid_argument")  # pragma: no cover


def encode_args(function: str, values: dict[str, Any]) -> list[SCVal]:
    """Validate + encode the arguments of an admin function in contract order."""
    spec = ADMIN_FUNCTIONS.get(function)
    if spec is None:
        raise ValidationError(f"unknown admin function {function}", code="unknown_function")
    missing = [name for name, _ in spec if name not in values]
    if missing:
        raise ValidationError(f"missing arguments: {', '.join(missing)}", code="missing_argument")
    return [_encode(kind, name, values[name]) for name, kind in spec]


def _require_contract(settings: Settings) -> tuple[str, str]:
    if not settings.vault_contract_id:
        raise StellarError("VAULT_CONTRACT_ID is not configured", code="contract_not_configured")
    rpc = settings.effective_rpc_url
    if not rpc:
        raise StellarError("SOROBAN_RPC_URL is not configured", code="rpc_not_configured")
    return settings.vault_contract_id, rpc


async def build_admin_invoke_xdr(settings: Settings, function: str, values: dict[str, Any], source: str) -> str:
    """Simulate + assemble `function(values)` on the vault with `source` as the tx source account and
    return the unsigned envelope XDR (auth entries use source-account credentials, so the admin's
    single signature authorises the call)."""
    contract_id, rpc = _require_contract(settings)
    params = encode_args(function, values)
    http = AiohttpClient()
    try:
        client = ContractClientAsync(contract_id, rpc, settings.network_passphrase, request_client=http)
        tx = await client.invoke(
            function,
            params,
            source=source,
            signer=None,
            base_fee=settings.base_fee_stroops,
            transaction_timeout=settings.tx_timeout_seconds,
            simulate=True,
        )
        return tx.to_xdr()
    except (StellarError, ValidationError):
        raise
    except Exception as e:
        log.warning("admin tx build failed fn=%s: %s: %s", function, e.__class__.__name__, str(e)[:300])
        raise StellarError(
            f"could not build {function}: {e.__class__.__name__}: {str(e)[:300]}", code="tx_build_failed"
        ) from e
    finally:
        await http.close()
