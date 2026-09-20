"""SEP-10 web authentication (wallet login) and simple message-signature login.

Copied from _parked; `AccountSigners` now lives in app.services.stellar.types (re-exported here).

Public API used by routers/auth.py:
  build_challenge(settings, client_account, memo=None) -> str                (challenge XDR)
  await verify_challenge(settings, signed_xdr, account_info_lookup) -> str   (client G... key)
  verify_message_signature(public_key, message_bytes, signature_b64) -> bool
  is_valid_public_key(pk) -> bool
  server_public_key(settings) -> str                                         (SIGNING_KEY for stellar.toml)

`account_info_lookup` is an async callable `pk -> object | None` (typically gateway.get_account or
gateway.get_account_signers). It is only consulted when the master-key signature check fails: if it
returns None the account does not exist and SEP-10 mandates master-key verification (-> 401); if it
returns an object exposing `signers` (see AccountSigners) the challenge is verified against those
signers with the account's medium threshold.
"""
from __future__ import annotations

import base64
import binascii
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from stellar_sdk import Keypair
from stellar_sdk.exceptions import BadSignatureError, Ed25519PublicKeyInvalidError, SdkError
from stellar_sdk.muxed_account import MuxedAccount
from stellar_sdk.sep import stellar_web_authentication as swa
from stellar_sdk.sep.ed25519_public_key_signer import Ed25519PublicKeySigner
from stellar_sdk.sep.exceptions import InvalidSep10ChallengeError

from app.core.config import Settings
from app.core.errors import UnauthorizedError, ValidationError
from app.services.stellar.types import AccountSigners
from app.services.stellar.xdr_utils import is_valid_public_key, public_key_from_secret

log = logging.getLogger(__name__)

__all__ = [
    "AccountSigners",
    "AccountLookup",
    "build_challenge",
    "is_valid_public_key",
    "server_public_key",
    "verify_challenge",
    "verify_message_signature",
]




AccountLookup = Callable[[str], Awaitable[Any | None]]


def server_public_key(settings: Settings) -> str:
    return public_key_from_secret(settings.sep10_server_secret)


def _kwargs(settings: Settings) -> dict[str, Any]:
    return {
        "server_account_id": server_public_key(settings),
        "home_domains": settings.home_domain,
        "web_auth_domain": settings.web_auth_domain,
        "network_passphrase": settings.network_passphrase,
    }


def build_challenge(settings: Settings, client_account: str, memo: int | None = None) -> str:
    """Server-signed SEP-10 challenge transaction (base64 XDR) for `client_account`."""
    if not is_valid_public_key(client_account):
        raise ValidationError("invalid Stellar public key", code="invalid_public_key")
    if memo is not None:
        if isinstance(memo, bool) or not isinstance(memo, int) or memo < 0 or memo >= 2**64:
            raise ValidationError("memo must be an unsigned 64-bit integer", code="invalid_memo")
    try:
        return swa.build_challenge_transaction(
            server_secret=settings.sep10_server_secret,
            client_account_id=client_account,
            home_domain=settings.home_domain,
            web_auth_domain=settings.web_auth_domain,
            network_passphrase=settings.network_passphrase,
            timeout=settings.sep10_challenge_timeout,
            memo=memo,
        )
    except (SdkError, ValueError) as e:
        raise ValidationError(f"cannot build SEP-10 challenge: {e}", code="sep10_build_failed") from e


def _to_g_address(account: str) -> str:
    if account.startswith("M"):
        return MuxedAccount.from_account(account).account_id
    return account


def _signers_from(info: object) -> list[tuple[str, int]]:
    raw = getattr(info, "signers", None)
    if not raw:
        return []
    out: list[tuple[str, int]] = []
    for item in raw:
        if isinstance(item, dict):
            if item.get("type", "ed25519_public_key") != "ed25519_public_key":
                continue
            key, weight = item.get("key"), item.get("weight", 0)
        else:
            key, weight = item[0], item[1]
        if isinstance(key, str) and is_valid_public_key(key) and int(weight) > 0:
            out.append((key, int(weight)))
    return out


async def verify_challenge(
    settings: Settings, signed_xdr: str, account_info_lookup: AccountLookup | None = None
) -> str:
    """Verify a client-signed SEP-10 challenge and return the client's G... public key.

    Raises UnauthorizedError(code="sep10_challenge_invalid") on any failure.
    """
    if not isinstance(signed_xdr, str) or not signed_xdr.strip():
        raise UnauthorizedError("missing SEP-10 challenge transaction", code="sep10_challenge_invalid")
    kwargs = _kwargs(settings)
    try:
        challenge = swa.read_challenge_transaction(signed_xdr, **kwargs)
    except (InvalidSep10ChallengeError, SdkError, ValueError) as e:
        raise UnauthorizedError(f"invalid SEP-10 challenge: {e}", code="sep10_challenge_invalid") from e

    client_account = _to_g_address(challenge.client_account_id)
    try:
        swa.verify_challenge_transaction_signed_by_client_master_key(signed_xdr, **kwargs)
        return client_account
    except (InvalidSep10ChallengeError, SdkError, ValueError) as master_err:
        master_reason = str(master_err)

    if account_info_lookup is None:
        raise UnauthorizedError(f"challenge not signed by client master key: {master_reason}", code="sep10_challenge_invalid")

    info = await account_info_lookup(client_account)
    if info is None:
        # SEP-10: an account that does not exist on the ledger must sign with its master key.
        raise UnauthorizedError(
            f"account not found on the ledger; master key signature required: {master_reason}",
            code="sep10_challenge_invalid",
        )
    signers = _signers_from(info)
    if not signers:
        raise UnauthorizedError(f"challenge not signed by client master key: {master_reason}", code="sep10_challenge_invalid")
    threshold = max(int(getattr(info, "med_threshold", 0) or 0), 1)
    try:
        swa.verify_challenge_transaction_threshold(
            signed_xdr,
            **kwargs,
            threshold=threshold,
            signers=[Ed25519PublicKeySigner(key, weight) for key, weight in signers],
        )
    except (InvalidSep10ChallengeError, SdkError, ValueError) as e:
        raise UnauthorizedError(f"challenge signatures do not meet the account threshold: {e}", code="sep10_challenge_invalid") from e
    log.info("sep10 challenge verified via account signers for %s (threshold=%d)", client_account, threshold)
    return client_account


def _decode_signature(signature_b64: str) -> bytes | None:
    if not isinstance(signature_b64, str) or not signature_b64.strip():
        return None
    s = signature_b64.strip()
    padded = s + "=" * (-len(s) % 4)
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            raw = decoder(padded)
        except (binascii.Error, ValueError):
            continue
        if len(raw) == 64:
            return raw
    return None


def verify_message_signature(public_key: str, message: bytes, signature_b64: str) -> bool:
    """True iff `signature_b64` (base64/urlsafe-base64 ed25519 signature) signs `message` for `public_key`."""
    if not is_valid_public_key(public_key):
        return False
    if isinstance(message, str):
        message = message.encode("utf-8")
    signature = _decode_signature(signature_b64)
    if signature is None:
        return False
    try:
        Keypair.from_public_key(public_key).verify(message, signature)
    except (BadSignatureError, Ed25519PublicKeyInvalidError, ValueError):
        return False
    return True
