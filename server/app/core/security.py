"""JWT access tokens + AES-GCM encryption of pool secrets."""
from __future__ import annotations

import base64
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import Settings
from app.core.errors import UnauthorizedError


@dataclass(frozen=True)
class TokenClaims:
    public_key: str  # Stellar G... address (sub)
    user_id: uuid.UUID | None
    role: str | None
    expires_at: datetime
    jti: str


def create_access_token(settings: Settings, *, public_key: str, user_id: uuid.UUID | None, role: str | None) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": public_key,
        "uid": str(user_id) if user_id else None,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=settings.access_token_ttl_seconds)).timestamp()),
        "jti": uuid.uuid4().hex,
        "iss": settings.web_auth_domain,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(settings: Settings, token: str) -> TokenClaims:
    try:
        data = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            issuer=settings.web_auth_domain,
            options={"require": ["sub", "exp", "iat", "jti"]},
        )
    except jwt.ExpiredSignatureError as e:
        raise UnauthorizedError("Token expired", code="token_expired") from e
    except jwt.InvalidTokenError as e:
        raise UnauthorizedError("Invalid token", code="token_invalid") from e
    uid = data.get("uid")
    return TokenClaims(
        public_key=data["sub"],
        user_id=uuid.UUID(uid) if uid else None,
        role=data.get("role"),
        expires_at=datetime.fromtimestamp(data["exp"], tz=UTC),
        jti=data["jti"],
    )


# --- pool secret encryption ---------------------------------------------------------------
# Format: nonce(12) || ciphertext||tag  (AES-256-GCM). Associated data = pool public key so a
# ciphertext cannot be swapped between pool rows.


def _load_key(settings: Settings) -> bytes:
    raw = settings.pool_key_encryption_key
    try:
        key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except Exception as e:  # pragma: no cover - config error
        raise RuntimeError("POOL_KEY_ENCRYPTION_KEY must be urlsafe-base64") from e
    if len(key) != 32:
        raise RuntimeError("POOL_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes")
    return key


def encrypt_secret(settings: Settings, secret: str, *, associated: str) -> bytes:
    key = _load_key(settings)
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, secret.encode("utf-8"), associated.encode("utf-8"))
    return nonce + ct


def decrypt_secret(settings: Settings, blob: bytes, *, associated: str) -> str:
    key = _load_key(settings)
    nonce, ct = blob[:12], blob[12:]
    return AESGCM(key).decrypt(nonce, ct, associated.encode("utf-8")).decode("utf-8")


def generate_encryption_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode()
