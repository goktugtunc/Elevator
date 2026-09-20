"""Auth I/O models (SEP-10 and nonce/message-signature login)."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.users import MeOut


class Sep10ChallengeOut(BaseModel):
    transaction: str
    network_passphrase: str


class Sep10VerifyIn(BaseModel):
    transaction: str = Field(min_length=1, description="Challenge transaction XDR signed by the client")


class NonceIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    public_key: str = Field(min_length=1, max_length=64)


class NonceOut(BaseModel):
    nonce: str
    message: str
    expires_at: datetime


class VerifyIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    public_key: str = Field(min_length=1, max_length=64)
    nonce: str = Field(min_length=1, max_length=64)
    signature: str = Field(min_length=1, max_length=256, description="base64 ed25519 signature over the message")


class LoginOut(BaseModel):
    token: str
    expires_at: datetime
    public_key: str
    registered: bool
    user: MeOut | None = None


class AuthMeOut(BaseModel):
    public_key: str
    registered: bool
    user: MeOut | None = None
    token_expires_at: datetime
