"""Wallet authentication (Figma 1d): SEP-10 challenge/response and nonce + message-signature login."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api_deps import DB, Claims, HorizonDep, SettingsDep
from app.schemas.auth import (
    AuthMeOut,
    LoginOut,
    NonceIn,
    NonceOut,
    Sep10ChallengeOut,
    Sep10VerifyIn,
    VerifyIn,
)
from app.services import auth as auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/sep10", response_model=Sep10ChallengeOut)
async def sep10_challenge(
    settings: SettingsDep,
    account: Annotated[str, Query(min_length=1, max_length=64, description="Client account G...")],
    memo: Annotated[int | None, Query(ge=0, description="Optional SEP-10 ID memo")] = None,
) -> Sep10ChallengeOut:
    """SEP-10 step 1: server-signed challenge transaction for the wallet to sign (never submitted)."""
    return auth_service.sep10_challenge(settings, account, memo)


@router.post("/sep10", response_model=LoginOut)
async def sep10_verify(body: Sep10VerifyIn, db: DB, settings: SettingsDep, horizon=HorizonDep) -> LoginOut:
    """SEP-10 step 2: verify the signed challenge and issue a JWT."""
    return await auth_service.sep10_login(db, settings, horizon, body.transaction)


@router.post("/nonce", response_model=NonceOut)
async def create_nonce(body: NonceIn, db: DB, settings: SettingsDep) -> NonceOut:
    """Simple flow step 1: one-time nonce; the wallet signs `message` with its ed25519 key."""
    return await auth_service.create_nonce(db, settings, body.public_key)


@router.post("/verify", response_model=LoginOut)
async def verify_nonce(body: VerifyIn, db: DB, settings: SettingsDep) -> LoginOut:
    """Simple flow step 2: verify the base64 signature over the message and issue a JWT."""
    return await auth_service.verify_nonce_login(db, settings, body.public_key, body.nonce, body.signature)


@router.get("/me", response_model=AuthMeOut)
async def me(claims: Claims, db: DB) -> AuthMeOut:
    """Who am I: valid token required, profile optional (registered=false before /users/register)."""
    return await auth_service.auth_me(db, claims)


@router.post("/refresh", response_model=LoginOut)
async def refresh(claims: Claims, db: DB, settings: SettingsDep) -> LoginOut:
    """Exchange a valid token for a fresh one (claims re-read from the database)."""
    return await auth_service.refresh_token(db, settings, claims)
