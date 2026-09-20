"""Auth slice: nonce + message-signature login, SEP-10 challenge/response, /auth/me, /auth/refresh."""
from __future__ import annotations

import base64
import importlib

import pytest
from stellar_sdk import Keypair, TransactionEnvelope

from app.core.config import get_settings
from app.core.security import create_access_token, decode_access_token

ROUTERS = ("auth", "users", "notifications", "assets", "config", "admin")


def mount_routers(names: tuple[str, ...] = ROUTERS) -> None:
    """Mount this slice's routers on the app when app.main's ROUTER_MODULES does not list them yet.
    New routes go to the FRONT so /api/v1/config beats the minimal copy in routers/meta.py."""
    from app.main import app

    prefix = get_settings().api_prefix
    existing = {getattr(r, "path", None) for r in app.router.routes}
    for name in names:
        module = importlib.import_module(f"app.routers.{name}")
        wanted = {prefix + r.path for r in module.router.routes}
        if wanted <= existing:
            continue
        before = len(app.router.routes)
        app.include_router(module.router, prefix=prefix)
        new = app.router.routes[before:]
        del app.router.routes[before:]
        app.router.routes[0:0] = new
        existing |= wanted


@pytest.fixture(scope="module", autouse=True)
def _mounted() -> None:
    mount_routers()


def sign_message(kp: Keypair, message: str) -> str:
    return base64.b64encode(kp.sign(message.encode("utf-8"))).decode()


# --- nonce flow ---------------------------------------------------------------------------------------


async def test_nonce_login_unregistered_wallet(client):
    kp = Keypair.random()
    r = await client.post("/api/v1/auth/nonce", json={"public_key": kp.public_key})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"] == f"traderkirala-login:{body['nonce']}"

    r = await client.post(
        "/api/v1/auth/verify",
        json={"public_key": kp.public_key, "nonce": body["nonce"], "signature": sign_message(kp, body["message"])},
    )
    assert r.status_code == 200, r.text
    login = r.json()
    assert login["registered"] is False and login["user"] is None and login["public_key"] == kp.public_key
    claims = decode_access_token(get_settings(), login["token"])
    assert claims.public_key == kp.public_key and claims.user_id is None and claims.role is None

    # nonce is single-use
    r = await client.post(
        "/api/v1/auth/verify",
        json={"public_key": kp.public_key, "nonce": body["nonce"], "signature": sign_message(kp, body["message"])},
    )
    assert r.status_code == 401 and r.json()["code"] == "nonce_used"


async def test_nonce_login_registered_wallet_and_bad_signature(client, make_user):
    kp = Keypair.random()
    user, _ = await make_user("trader", keypair=kp, username="ali_trader")
    nonce = (await client.post("/api/v1/auth/nonce", json={"public_key": kp.public_key})).json()

    other = Keypair.random()
    r = await client.post(
        "/api/v1/auth/verify",
        json={"public_key": kp.public_key, "nonce": nonce["nonce"], "signature": sign_message(other, nonce["message"])},
    )
    assert r.status_code == 401 and r.json()["code"] == "signature_invalid"

    r = await client.post(
        "/api/v1/auth/verify",
        json={"public_key": kp.public_key, "nonce": nonce["nonce"], "signature": sign_message(kp, nonce["message"])},
    )
    assert r.status_code == 200, r.text
    login = r.json()
    assert login["registered"] is True
    assert login["user"]["username"] == "ali_trader" and login["user"]["role"] == "trader"
    assert "expo_push_token" in login["user"]  # MeOut, not the public shape
    claims = decode_access_token(get_settings(), login["token"])
    assert claims.user_id == user.id and claims.role == "trader"


async def test_nonce_rejects_invalid_key_and_unknown_nonce(client):
    r = await client.post("/api/v1/auth/nonce", json={"public_key": "GNOTAKEY"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_public_key"
    kp = Keypair.random()
    r = await client.post(
        "/api/v1/auth/verify", json={"public_key": kp.public_key, "nonce": "deadbeef", "signature": "AAAA"}
    )
    assert r.status_code == 401 and r.json()["code"] == "nonce_invalid"


async def test_disabled_account_cannot_login(client, make_user):
    kp = Keypair.random()
    await make_user("customer", keypair=kp, is_active=False)
    nonce = (await client.post("/api/v1/auth/nonce", json={"public_key": kp.public_key})).json()
    r = await client.post(
        "/api/v1/auth/verify",
        json={"public_key": kp.public_key, "nonce": nonce["nonce"], "signature": sign_message(kp, nonce["message"])},
    )
    assert r.status_code == 403 and r.json()["code"] == "account_disabled"


# --- SEP-10 flow ------------------------------------------------------------------------------------------


async def test_sep10_challenge_and_login(client, horizon, make_user):
    settings = get_settings()
    kp = Keypair.random()
    r = await client.get("/api/v1/auth/sep10", params={"account": kp.public_key})
    assert r.status_code == 200, r.text
    challenge = r.json()
    assert challenge["network_passphrase"] == settings.network_passphrase
    env = TransactionEnvelope.from_xdr(challenge["transaction"], settings.network_passphrase)
    assert env.transaction.sequence == 0  # SEP-10: never submittable
    assert len(env.signatures) == 1  # server signature
    ops = env.transaction.operations
    assert ops[0].source.account_id == kp.public_key
    assert ops[0].data_name == f"{settings.home_domain} auth"

    # unsigned by the client -> 401
    r = await client.post("/api/v1/auth/sep10", json={"transaction": challenge["transaction"]})
    assert r.status_code == 401, r.text
    assert r.json()["code"].startswith("sep10")

    env.sign(kp)
    r = await client.post("/api/v1/auth/sep10", json={"transaction": env.to_xdr()})
    assert r.status_code == 200, r.text
    login = r.json()
    assert login["registered"] is False and login["public_key"] == kp.public_key

    # registered wallet: role embedded in the token
    kp2 = Keypair.random()
    await make_user("customer", keypair=kp2, username="ayse_c")
    xdr = (await client.get("/api/v1/auth/sep10", params={"account": kp2.public_key})).json()["transaction"]
    env2 = TransactionEnvelope.from_xdr(xdr, settings.network_passphrase)
    env2.sign(kp2)
    r = await client.post("/api/v1/auth/sep10", json={"transaction": env2.to_xdr()})
    assert r.status_code == 200, r.text
    assert r.json()["registered"] is True and r.json()["user"]["username"] == "ayse_c"
    assert decode_access_token(settings, r.json()["token"]).role == "customer"


async def test_sep10_rejects_wrong_signer_and_garbage(client, horizon):
    settings = get_settings()
    kp, other = Keypair.random(), Keypair.random()
    xdr = (await client.get("/api/v1/auth/sep10", params={"account": kp.public_key})).json()["transaction"]
    env = TransactionEnvelope.from_xdr(xdr, settings.network_passphrase)
    env.sign(other)
    r = await client.post("/api/v1/auth/sep10", json={"transaction": env.to_xdr()})
    assert r.status_code == 401
    r = await client.post("/api/v1/auth/sep10", json={"transaction": "not-xdr"})
    assert r.status_code == 401
    r = await client.get("/api/v1/auth/sep10", params={"account": "GBAD"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_public_key"


# --- me / refresh -----------------------------------------------------------------------------------------


async def test_me_and_refresh(client, make_user, auth_headers):
    settings = get_settings()
    user, token = await make_user("trader", username="mehmet")
    r = await client.get("/api/v1/auth/me", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["registered"] is True and r.json()["user"]["id"] == str(user.id)

    r = await client.post("/api/v1/auth/refresh", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    assert decode_access_token(settings, r.json()["token"]).user_id == user.id

    # a wallet token without a profile
    kp = Keypair.random()
    bare = create_access_token(settings, public_key=kp.public_key, user_id=None, role=None)
    r = await client.get("/api/v1/auth/me", headers=auth_headers(bare))
    assert r.status_code == 200 and r.json()["registered"] is False and r.json()["user"] is None

    r = await client.get("/api/v1/auth/me")
    assert r.status_code == 401 and r.json()["code"] == "missing_token"
    r = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401 and r.json()["code"] == "token_invalid"
