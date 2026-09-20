"""Wallet login: SEP-10 challenge flow and the simpler nonce/message-signature flow.

Both end in `build_login_response`, which issues the JWT (role embedded when a profile exists)
and stamps `User.last_login_at`. stellar_sdk is only touched through app.services.stellar.sep10.
"""
from __future__ import annotations

import logging
import secrets
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError, ForbiddenError, UnauthorizedError, ValidationError
from app.core.security import TokenClaims, create_access_token, decode_access_token
from app.models import AuthNonce, User
from app.schemas.auth import AuthMeOut, LoginOut, NonceOut, Sep10ChallengeOut
from app.schemas.users import MeOut
from app.services.stellar.sep10 import (
    build_challenge,
    is_valid_public_key,
    verify_challenge,
    verify_message_signature,
)
from app.services.users import get_by_stellar_address

log = logging.getLogger(__name__)

LOGIN_MESSAGE_PREFIX = "elevator-login:"


def login_message(nonce: str) -> str:
    """The exact UTF-8 text the wallet must sign for the nonce flow."""
    return f"{LOGIN_MESSAGE_PREFIX}{nonce}"


def require_valid_public_key(public_key: str) -> str:
    if not public_key or not is_valid_public_key(public_key):
        raise ValidationError("Invalid Stellar public key", code="invalid_public_key")
    return public_key


# --- tokens ------------------------------------------------------------------------------------------


def issue_token(settings: Settings, public_key: str, user: User | None) -> tuple[str, datetime]:
    """JWT for a wallet; role/uid claims only when a profile exists. Returns (token, expires_at)."""
    token = create_access_token(
        settings,
        public_key=public_key,
        user_id=user.id if user else None,
        role=user.role.value if user else None,
    )
    return token, decode_access_token(settings, token).expires_at


async def build_login_response(db: AsyncSession, settings: Settings, public_key: str) -> LoginOut:
    """Shared tail of every login flow: look up the profile, refuse disabled accounts, issue a token."""
    user = await get_by_stellar_address(db, public_key)
    if user is not None:
        if not user.is_active:
            raise ForbiddenError("Account disabled", code="account_disabled")
        user.last_login_at = datetime.now(UTC)
        await db.flush()
        await db.refresh(user)  # reload server-side updated_at instead of leaving it expired
    token, expires_at = issue_token(settings, public_key, user)
    return LoginOut(
        token=token,
        expires_at=expires_at,
        public_key=public_key,
        registered=user is not None,
        user=MeOut.model_validate(user) if user else None,
    )


async def refresh_token(db: AsyncSession, settings: Settings, claims: TokenClaims) -> LoginOut:
    """New token for a still-valid one; claims (role, uid) are re-read from the database."""
    return await build_login_response(db, settings, claims.public_key)


async def auth_me(db: AsyncSession, claims: TokenClaims) -> AuthMeOut:
    user = await get_by_stellar_address(db, claims.public_key)
    if user is not None and not user.is_active:
        raise ForbiddenError("Account disabled", code="account_disabled")
    return AuthMeOut(
        public_key=claims.public_key,
        registered=user is not None,
        user=MeOut.model_validate(user) if user else None,
        token_expires_at=claims.expires_at,
    )


# --- nonce / message signature flow ----------------------------------------------------------------------


async def create_nonce(db: AsyncSession, settings: Settings, public_key: str) -> NonceOut:
    require_valid_public_key(public_key)
    now = datetime.now(UTC)
    await purge_expired_nonces(db, older_than=now - timedelta(hours=1))
    row = AuthNonce(
        public_key=public_key,
        nonce=secrets.token_hex(16),
        expires_at=now + timedelta(seconds=settings.auth_nonce_ttl_seconds),
        used_at=None,
        created_at=now,
    )
    db.add(row)
    await db.flush()
    return NonceOut(nonce=row.nonce, message=login_message(row.nonce), expires_at=row.expires_at)


async def verify_nonce_login(
    db: AsyncSession, settings: Settings, public_key: str, nonce: str, signature_b64: str
) -> LoginOut:
    """Check an ed25519 signature over `login_message(nonce)`, burn the nonce, log the wallet in."""
    require_valid_public_key(public_key)
    row = (
        await db.execute(select(AuthNonce).where(AuthNonce.nonce == nonce).with_for_update())
    ).scalar_one_or_none()
    if row is None or row.public_key != public_key:
        raise UnauthorizedError("Unknown nonce", code="nonce_invalid")
    now = datetime.now(UTC)
    if row.used_at is not None:
        raise UnauthorizedError("Nonce already used", code="nonce_used")
    if row.expires_at <= now:
        raise UnauthorizedError("Nonce expired", code="nonce_expired")
    if not verify_message_signature(public_key, login_message(nonce).encode("utf-8"), signature_b64):
        raise UnauthorizedError("Signature does not match", code="signature_invalid")
    row.used_at = now
    await db.flush()
    log.info("nonce login ok pk=%s", public_key)
    return await build_login_response(db, settings, public_key)


async def purge_expired_nonces(db: AsyncSession, *, older_than: datetime | None = None) -> int:
    """Delete nonces whose expiry passed before `older_than` (default: now). Returns rows removed."""
    cutoff = older_than or datetime.now(UTC)
    result = await db.execute(delete(AuthNonce).where(AuthNonce.expires_at < cutoff))
    return int(result.rowcount or 0)


# --- SEP-10 flow ---------------------------------------------------------------------------------------------


def sep10_challenge(settings: Settings, account: str, memo: int | None = None) -> Sep10ChallengeOut:
    require_valid_public_key(account)
    if memo is not None and memo < 0:
        raise ValidationError("memo must be a non-negative integer", code="invalid_memo")
    xdr = build_challenge(settings, account, memo)
    return Sep10ChallengeOut(transaction=xdr, network_passphrase=settings.network_passphrase)


AccountLookup = Callable[[str], Awaitable[Any | None]]


def account_lookup_of(horizon: Any) -> AccountLookup | None:
    """Multisig fallback for SEP-10: the Horizon gateway's signer lookup, if it offers one."""
    for name in ("get_account_signers", "get_account"):
        fn = getattr(horizon, name, None)
        if callable(fn):
            return fn
    return None


async def sep10_login(db: AsyncSession, settings: Settings, horizon: Any, signed_xdr: str) -> LoginOut:
    """Verify a client-signed SEP-10 challenge (never submitted to the network) and log that account in."""
    try:
        client_account = await verify_challenge(settings, signed_xdr, account_lookup_of(horizon))
    except AppError:
        raise
    except Exception as e:  # SDK / decoding errors must never leak as 500s
        log.info("sep10 verification failed: %s", e.__class__.__name__)
        raise UnauthorizedError("Invalid SEP-10 challenge", code="sep10_invalid") from e
    if not client_account or not is_valid_public_key(client_account):
        raise UnauthorizedError("Invalid SEP-10 challenge", code="sep10_invalid")
    log.info("sep10 login ok pk=%s", client_account)
    return await build_login_response(db, settings, client_account)
