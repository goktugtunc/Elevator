"""Anchor slice (SEP-1 / SEP-10 / SEP-24 / SEP-12) against a respx-mocked anchor that behaves like
testanchor.stellar.org: a real stellar.toml, real SEP-10 challenge transactions signed by the fake anchor's
SIGNING_KEY (auth hosted on ANOTHER host so `web_auth_domain` != `home_domain`), `/info`, interactive
deposit / withdraw, `/transaction?id=` with a status progression and SEP-12.

respx refuses every un-mocked host, so the tests also prove the backend never submits the challenge to
Horizon / RPC and never talks to anything but the anchor.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from email.parser import BytesParser
from email.policy import default as email_default
from typing import Any
from urllib.parse import parse_qsl, urlparse

import httpx
import jwt as pyjwt
import pytest
import respx
from sqlalchemy import select
from stellar_sdk import Keypair, TransactionEnvelope
from stellar_sdk.memo import HashMemo
from stellar_sdk.operation import ManageData, Payment
from stellar_sdk.sep import stellar_web_authentication as swa
from stellar_sdk.sep.exceptions import InvalidSep10ChallengeError

from app.core.config import TESTNET_PASSPHRASE, get_settings
from app.core.security import decrypt_secret
from app.models import AnchorSession, AnchorTransaction, Notification, PendingTransaction
from app.services import anchor as anchor_service
from app.services import fx
from app.services.anchor import AnchorClient, AnchorError, parse_toml, set_anchor_client, with_query
from app.worker.anchor_sync import run_anchor_sync_once
from tests.test_auth import mount_routers

API = "/api/v1"
DOMAIN = "anchor.test"
AUTH_HOST = "auth.anchor.test"  # != home domain on purpose (gotcha #2)
USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
ANCHOR_ACCOUNT = Keypair.from_raw_ed25519_seed(bytes([77]) * 32).public_key
JWT_SECRET = "fake-anchor-jwt-secret-with-32-bytes-min!!"


@pytest.fixture(scope="module", autouse=True)
def _mounted() -> None:
    mount_routers(("anchor", "wallet", "tx"))


@pytest.fixture(autouse=True)
def _fx_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    rate = fx.FxRate(rate=Decimal("41.5"), source="test", fetched_at=datetime.now(UTC))

    async def fake_get_usd_try(settings: Any, db: Any = None, **kw: Any) -> fx.FxRate:
        return rate

    monkeypatch.setattr(fx, "get_usd_try", fake_get_usd_try)


# --- the fake anchor -----------------------------------------------------------------------------------


class FakeAnchor:
    """SEP-1/10/24/12 server behaviour behind respx routes. Mutate the attributes between requests."""

    def __init__(self, mock: respx.MockRouter) -> None:
        self.server_kp = Keypair.random()
        self.rogue_kp = Keypair.random()
        self.use_rogue_key = False
        self.reject_auth = False  # 403 authentication_required on every authenticated call
        self.transactions: dict[str, dict[str, Any]] = {}
        self.requests: list[tuple[str, str, dict[str, Any]]] = []
        self.tokens: list[str] = []
        self.kyc_customers: dict[str, dict[str, Any]] = {}
        self._seq = 0
        base = f"https://{DOMAIN}"
        mock.get(f"{base}/.well-known/stellar.toml").mock(side_effect=self.toml)
        mock.get(f"https://{AUTH_HOST}/auth").mock(side_effect=self.challenge)
        mock.post(f"https://{AUTH_HOST}/auth").mock(side_effect=self.token)
        mock.get(f"{base}/sep24/info").mock(side_effect=self.info)
        mock.post(f"{base}/sep24/transactions/deposit/interactive").mock(side_effect=self.deposit)
        mock.post(f"{base}/sep24/transactions/withdraw/interactive").mock(side_effect=self.withdraw)
        mock.get(f"{base}/sep24/transaction").mock(side_effect=self.transaction)
        mock.get(f"{base}/sep24/transactions").mock(side_effect=self.list_transactions)
        mock.put(f"{base}/sep12/customer").mock(side_effect=self.kyc_put)
        mock.get(f"{base}/sep12/customer").mock(side_effect=self.kyc_get)

    # -- helpers --
    @property
    def signing_key(self) -> str:
        return self.server_kp.public_key

    def _auth(self, request: httpx.Request) -> httpx.Response | str:
        auth = request.headers.get("Authorization", "")
        if self.reject_auth or not auth.startswith("Bearer "):
            return httpx.Response(403, json={"type": "authentication_required"})
        token = auth.removeprefix("Bearer ")
        if token not in self.tokens:
            return httpx.Response(401, json={"type": "authentication_required"})
        return token

    def _form(self, request: httpx.Request) -> dict[str, str]:
        """Form fields from a urlencoded or multipart/form-data body (SEP-24 / SEP-12 send multipart)."""
        ctype = request.headers.get("content-type", "")
        if ctype.startswith("multipart/form-data"):
            msg = BytesParser(policy=email_default).parsebytes(
                b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + request.content
            )
            return {
                p.get_param("name", header="content-disposition"): (p.get_payload(decode=True) or b"").decode()
                for p in msg.iter_parts()
            }
        return dict(parse_qsl(request.content.decode(), keep_blank_values=True))

    def set_status(self, tx_id: str, status: str, **fields: Any) -> None:
        tx = self.transactions[tx_id]
        tx["status"] = status
        tx.update(fields)

    # -- SEP-1 --
    def toml(self, request: httpx.Request) -> httpx.Response:
        body = f'''
VERSION = "2.0.0"
NETWORK_PASSPHRASE = "{TESTNET_PASSPHRASE}"
SIGNING_KEY = "{self.signing_key}"
WEB_AUTH_ENDPOINT = "https://{AUTH_HOST}/auth"
TRANSFER_SERVER_SEP0024 = "https://{DOMAIN}/sep24"
TRANSFER_SERVER = "https://{DOMAIN}/sep6"
KYC_SERVER = "https://{DOMAIN}/sep12"

[[CURRENCIES]]
code = "USDC"
issuer = "{USDC_ISSUER}"
desc = "Circle USDC Token"

[[CURRENCIES]]
code = "native"
desc = "XLM"
'''
        return httpx.Response(200, text=body, headers={"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"})

    # -- SEP-10 --
    def challenge(self, request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        self.requests.append(("GET", "/auth", params))
        account = params["account"]
        xdr = swa.build_challenge_transaction(
            server_secret=self.server_kp.secret,
            client_account_id=account,
            home_domain=DOMAIN,
            web_auth_domain=AUTH_HOST,
            network_passphrase=TESTNET_PASSPHRASE,
            timeout=900,
        )
        if self.use_rogue_key:  # man-in-the-middle: same envelope, signature by a key that is NOT SIGNING_KEY
            env = TransactionEnvelope.from_xdr(xdr, TESTNET_PASSPHRASE)
            env.signatures = []
            env.sign(self.rogue_kp)
            xdr = env.to_xdr()
        return httpx.Response(200, json={"transaction": xdr, "network_passphrase": TESTNET_PASSPHRASE})

    def token(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        try:
            parsed = swa.read_challenge_transaction(
                body["transaction"], self.signing_key, DOMAIN, AUTH_HOST, TESTNET_PASSPHRASE
            )
            swa.verify_challenge_transaction_signed_by_client_master_key(
                body["transaction"], self.signing_key, DOMAIN, AUTH_HOST, TESTNET_PASSPHRASE
            )
        except InvalidSep10ChallengeError as e:
            return httpx.Response(400, json={"error": str(e)})
        now = int(time.time())
        token = pyjwt.encode(
            {"iss": f"https://{AUTH_HOST}/auth", "sub": parsed.client_account_id, "iat": now, "exp": now + 3600, "jti": uuid.uuid4().hex},
            JWT_SECRET,
            algorithm="HS256",
        )
        self.tokens.append(token)
        return httpx.Response(200, json={"token": token})

    # -- SEP-24 --
    def info(self, request: httpx.Request) -> httpx.Response:
        limits = {"enabled": True, "min_amount": 1, "max_amount": 10}
        return httpx.Response(
            200,
            json={
                "deposit": {"USDC": dict(limits), "native": dict(limits), "SRT": dict(limits)},
                "withdraw": {"USDC": dict(limits), "native": dict(limits), "SRT": dict(limits)},
                "fee": {"enabled": False},
                "features": {"account_creation": False, "claimable_balances": False},
            },
        )

    def _start(self, request: httpx.Request, kind: str) -> httpx.Response:
        auth = self._auth(request)
        if isinstance(auth, httpx.Response):
            return auth
        form = self._form(request)
        self.requests.append(("POST", f"/sep24/transactions/{kind}/interactive", form))
        self._seq += 1
        tx_id = f"{kind[:3]}-{self._seq}"
        now = datetime.now(UTC).isoformat()
        self.transactions[tx_id] = {
            "id": tx_id,
            "kind": "deposit" if kind == "deposit" else "withdrawal",
            "status": "incomplete",
            "amount_in": form.get("amount"),
            "amount_out": None,
            "amount_fee": None,
            "started_at": now,
            "more_info_url": f"https://{DOMAIN}/sep24/transaction/more_info?id={tx_id}",
            "_asset_code": form["asset_code"],
        }
        return httpx.Response(
            200,
            json={"type": "interactive_customer_info_needed", "url": f"https://{DOMAIN}/sep24/start?token=tok-{tx_id}", "id": tx_id},
        )

    def deposit(self, request: httpx.Request) -> httpx.Response:
        return self._start(request, "deposit")

    def withdraw(self, request: httpx.Request) -> httpx.Response:
        return self._start(request, "withdraw")

    def _public(self, tx: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in tx.items() if not k.startswith("_")}

    def transaction(self, request: httpx.Request) -> httpx.Response:
        auth = self._auth(request)
        if isinstance(auth, httpx.Response):
            return auth
        tx_id = request.url.params.get("id")
        self.requests.append(("GET", "/sep24/transaction", {"id": tx_id}))
        tx = self.transactions.get(tx_id or "")
        if tx is None:
            return httpx.Response(404, json={"error": "transaction not found"})
        return httpx.Response(200, json={"transaction": self._public(tx)})

    def list_transactions(self, request: httpx.Request) -> httpx.Response:
        auth = self._auth(request)
        if isinstance(auth, httpx.Response):
            return auth
        code = request.url.params.get("asset_code")
        self.requests.append(("GET", "/sep24/transactions", dict(request.url.params)))
        items = [self._public(t) for t in self.transactions.values() if t["_asset_code"] == code]
        return httpx.Response(200, json={"transactions": items})

    # -- SEP-12 --
    def kyc_put(self, request: httpx.Request) -> httpx.Response:
        auth = self._auth(request)
        if isinstance(auth, httpx.Response):
            return auth
        form = self._form(request)
        self.requests.append(("PUT", "/sep12/customer", form))
        cid = form.get("id") or f"cust-{len(self.kyc_customers) + 1}"
        self.kyc_customers[cid] = {"id": cid, "status": "ACCEPTED", "provided_fields": {k: {"status": "ACCEPTED"} for k in form if k not in ("id", "type")}}
        return httpx.Response(202, json={"id": cid})

    def kyc_get(self, request: httpx.Request) -> httpx.Response:
        auth = self._auth(request)
        if isinstance(auth, httpx.Response):
            return auth
        cid = request.url.params.get("id")
        cust = self.kyc_customers.get(cid or "")
        if cust is None:
            return httpx.Response(200, json={"status": "NEEDS_INFO", "fields": {"first_name": {"type": "string"}}})
        return httpx.Response(200, json=cust)


@pytest.fixture
def anchor(settings):
    anchor_service.reset_cache()
    anchor_service.reset_rate_limits()
    with respx.mock(assert_all_called=False, assert_all_mocked=True) as mock:
        fake = FakeAnchor(mock)
        set_anchor_client(AnchorClient(settings, domain=DOMAIN))
        try:
            yield fake
        finally:
            set_anchor_client(None)
            anchor_service.reset_cache()


def sign(xdr: str, kp: Keypair) -> str:
    env = TransactionEnvelope.from_xdr(xdr, TESTNET_PASSPHRASE)
    env.sign(kp)
    return env.to_xdr()


async def authenticate(client, headers: dict[str, str], kp: Keypair) -> dict[str, Any]:
    r = await client.post(f"{API}/anchor/auth/challenge", headers=headers, json={})
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/anchor/auth/token", headers=headers, json={"signed_xdr": sign(r.json()["transaction"], kp)})
    assert r.status_code == 200, r.text
    return r.json()


# --- SEP-1 / SEP-10 ------------------------------------------------------------------------------------


async def test_info_exposes_toml_and_sep24_info(client, make_user, auth_headers, anchor: FakeAnchor):
    user, tok = await make_user("customer")
    r = await client.get(f"{API}/anchor/info", headers=auth_headers(tok))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True and body["home_domain"] == DOMAIN
    assert body["signing_key"] == anchor.signing_key and body["web_auth_domain"] == AUTH_HOST
    assert body["transfer_server_sep24"] == f"https://{DOMAIN}/sep24" and body["kyc_server"] == f"https://{DOMAIN}/sep12"
    assert body["features"] == {"account_creation": False, "claimable_balances": False}
    codes = {a["code"]: a for a in body["assets"]}
    assert set(codes) == {"native", "USDC"}  # ANCHOR_ASSETS default `native,USDC` (SRT is not offered)
    assert codes["USDC"]["issuer"] == USDC_ISSUER and codes["USDC"]["needs_trustline"] is True
    assert codes["native"]["display_code"] == "XLM" and codes["native"]["needs_trustline"] is False
    assert codes["USDC"]["deposit_min"] == "1" and codes["USDC"]["withdraw_max"] == "10"  # decimal strings
    assert body["session"] == {"anchor_domain": DOMAIN, "authenticated": False, "account": None, "expires_at": None}
    # anonymous works too (no session block)
    r = await client.get(f"{API}/anchor/info")
    assert r.status_code == 200 and r.json()["session"] is None


async def test_challenge_is_verified_and_never_submitted(client, make_user, auth_headers, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    r = await client.post(f"{API}/anchor/auth/challenge", headers=auth_headers(tok), json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["home_domain"] == DOMAIN and body["web_auth_domain"] == AUTH_HOST and body["signing_key"] == anchor.signing_key
    assert body["account"] == kp.public_key and body["network_passphrase"] == TESTNET_PASSPHRASE
    env = TransactionEnvelope.from_xdr(body["transaction"], TESTNET_PASSPHRASE)
    tx = env.transaction
    assert tx.sequence == 0  # cannot be submitted (gotcha #1)
    assert tx.source.account_id == anchor.signing_key
    ops = tx.operations
    assert isinstance(ops[0], ManageData) and ops[0].data_name == f"{DOMAIN} auth" and ops[0].source.account_id == kp.public_key
    web_auth_ops = [op for op in ops if isinstance(op, ManageData) and op.data_name == "web_auth_domain"]
    assert web_auth_ops and web_auth_ops[0].data_value == AUTH_HOST.encode()
    assert len(env.signatures) == 1  # anchor signature only; the mobile adds the user's
    expires = datetime.fromisoformat(body["expires_at"])
    assert timedelta(minutes=10) < expires - datetime.now(UTC) <= timedelta(minutes=15, seconds=5)
    # the anchor received home_domain explicitly
    assert anchor.requests[-1] == ("GET", "/auth", {"account": kp.public_key, "home_domain": DOMAIN})


async def test_challenge_signed_by_wrong_key_is_rejected(client, make_user, auth_headers, anchor: FakeAnchor):
    user, tok = await make_user("customer")
    anchor.use_rogue_key = True
    r = await client.post(f"{API}/anchor/auth/challenge", headers=auth_headers(tok), json={})
    assert r.status_code == 502, r.text
    assert r.json()["code"] == "anchor_challenge_invalid"
    assert "not signed by server" in r.json()["message"]


async def test_challenge_for_wrong_account_or_domain_is_rejected(settings, anchor: FakeAnchor):
    client = AnchorClient(settings, domain=DOMAIN)
    disc = await client.discover()
    kp = Keypair.random()
    xdr = swa.build_challenge_transaction(anchor.server_kp.secret, kp.public_key, DOMAIN, AUTH_HOST, TESTNET_PASSPHRASE, 900)
    with pytest.raises(AnchorError) as ei:
        anchor_service.verify_challenge(xdr, disc, account=Keypair.random().public_key, network_passphrase=TESTNET_PASSPHRASE)
    assert ei.value.code == "anchor_challenge_invalid" and "another account" in ei.value.message
    # wrong home domain in the first manage_data key
    xdr = swa.build_challenge_transaction(anchor.server_kp.secret, kp.public_key, "evil.example", AUTH_HOST, TESTNET_PASSPHRASE, 900)
    with pytest.raises(AnchorError):
        anchor_service.verify_challenge(xdr, disc, account=kp.public_key, network_passphrase=TESTNET_PASSPHRASE)
    # web_auth_domain op pointing somewhere else
    xdr = swa.build_challenge_transaction(anchor.server_kp.secret, kp.public_key, DOMAIN, "evil.example", TESTNET_PASSPHRASE, 900)
    with pytest.raises(AnchorError):
        anchor_service.verify_challenge(xdr, disc, account=kp.public_key, network_passphrase=TESTNET_PASSPHRASE)


def test_parse_toml_validates_network_and_https():
    good = {
        "SIGNING_KEY": Keypair.random().public_key,
        "NETWORK_PASSPHRASE": TESTNET_PASSPHRASE,
        "WEB_AUTH_ENDPOINT": "https://a.test/auth/",
        "TRANSFER_SERVER_SEP0024": "https://a.test/sep24",
        "CURRENCIES": [{"code": "native"}, {"code": "usdc", "issuer": USDC_ISSUER}, {"code": "BAD", "issuer": "nope"}],
    }
    disc = parse_toml("a.test", good, expected_passphrase=TESTNET_PASSPHRASE)
    assert disc.web_auth_endpoint == "https://a.test/auth" and disc.web_auth_domain == "a.test"
    assert [c.code for c in disc.currencies] == ["native", "USDC"] and disc.currency("XLM").code == "native"
    assert disc.currency("usdc").issuer == USDC_ISSUER and disc.kyc_server is None
    with pytest.raises(AnchorError) as ei:
        parse_toml("a.test", {**good, "NETWORK_PASSPHRASE": "Public Global Stellar Network ; September 2015"}, expected_passphrase=TESTNET_PASSPHRASE)
    assert ei.value.code == "anchor_network_mismatch"
    with pytest.raises(AnchorError):
        parse_toml("a.test", {**good, "WEB_AUTH_ENDPOINT": "http://a.test/auth"}, expected_passphrase=TESTNET_PASSPHRASE)
    with pytest.raises(AnchorError):
        parse_toml("a.test", {**good, "SIGNING_KEY": "not-a-key"}, expected_passphrase=TESTNET_PASSPHRASE)


def test_with_query_and_status_helpers():
    url = with_query("https://a.test/start?token=abc", callback="postMessage")
    assert url == "https://a.test/start?token=abc&callback=postMessage"
    assert anchor_service.action_for("pending_user_transfer_start", "withdraw") == "send_payment"
    assert anchor_service.action_for("pending_user_transfer_start", "deposit") == "wait"
    assert anchor_service.action_for("pending_trust", "deposit") == "add_trustline"
    assert anchor_service.action_for("pending_user", "deposit") == "open_interactive"
    assert anchor_service.action_for("on_hold", "withdraw") == "wait"
    assert anchor_service.action_for("something_new", "deposit") == "wait"
    assert anchor_service.is_terminal("completed") and anchor_service.is_terminal("too_large") and not anchor_service.is_terminal("on_hold")
    assert anchor_service.normalize_asset_code("xlm") == "native" and anchor_service.normalize_asset_code(" usdc ") == "USDC"


async def test_token_stores_encrypted_jwt_and_never_returns_it(client, db, settings, make_user, auth_headers, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    body = await authenticate(client, headers, kp)
    assert body == {"anchor_domain": DOMAIN, "authenticated": True, "account": kp.public_key, "expires_at": body["expires_at"]}
    assert "token" not in body and "jwt" not in body
    session = (await db.execute(select(AnchorSession).where(AnchorSession.user_id == user.id))).scalar_one()
    issued = anchor.tokens[-1]
    assert bytes(session.jwt) != issued.encode() and issued.encode() not in bytes(session.jwt)
    assert decrypt_secret(settings, bytes(session.jwt), associated=kp.public_key) == issued
    exp = pyjwt.decode(issued, options={"verify_signature": False})["exp"]
    assert int(session.expires_at.timestamp()) == exp
    r = await client.get(f"{API}/anchor/auth/session", headers=headers)
    assert r.json()["authenticated"] is True and r.json()["account"] == kp.public_key
    # a tampered / unsigned challenge is refused before it reaches the anchor
    r = await client.post(f"{API}/anchor/auth/challenge", headers=headers, json={})
    r = await client.post(f"{API}/anchor/auth/token", headers=headers, json={"signed_xdr": r.json()["transaction"]})
    assert r.status_code == 422 and r.json()["code"] == "challenge_unsigned"
    # signed by another key: the anchor says no
    r = await client.post(f"{API}/anchor/auth/challenge", headers=headers, json={})
    r = await client.post(f"{API}/anchor/auth/token", headers=headers, json={"signed_xdr": sign(r.json()["transaction"], Keypair.random())})
    assert r.status_code == 502 and r.json()["code"] == "anchor_rejected"


# --- SEP-24 deposit ------------------------------------------------------------------------------------


async def test_deposit_flow_with_status_progression(client, db, settings, make_user, auth_headers, horizon, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    payload = {"asset_code": "USDC", "amount": "5", "lang": "tr", "callback": "postMessage"}

    # no anchor session yet -> 401 anchor_auth_required (mobile runs SEP-10, then retries)
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json=payload)
    assert r.status_code == 401 and r.json()["code"] == "anchor_auth_required"
    await authenticate(client, headers, kp)

    # account not on the ledger yet
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json=payload)
    assert r.status_code == 409 and r.json()["code"] == "account_not_funded"
    horizon.fund(kp.public_key)
    # funded but no USDC trustline and the anchor has no claimable balances -> add a trustline first
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json=payload)
    assert r.status_code == 409 and r.json()["code"] == "trustline_required"
    assert r.json()["details"] == {"asset_code": "USDC", "issuer": USDC_ISSUER}
    horizon.add_trustline(kp.public_key, "USDC", USDC_ISSUER)
    # /info limits are pre-validated
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={**payload, "amount": "50"})
    assert r.status_code == 422 and r.json()["code"] == "amount_too_large"
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={**payload, "asset_code": "SRT"})
    assert r.status_code == 422 and r.json()["code"] == "asset_not_offered"
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={**payload, "asset_issuer": Keypair.random().public_key})
    assert r.status_code == 422 and r.json()["code"] == "asset_issuer_mismatch"

    r = await client.post(f"{API}/anchor/deposit", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    started = r.json()
    assert started["kind"] == "deposit" and started["status"] == "incomplete" and started["action"] == "open_interactive"
    assert started["asset_code"] == "USDC" and started["asset_issuer"] == USDC_ISSUER and started["amount"] == "5"
    url = urlparse(started["interactive_url"])
    assert url.netloc == DOMAIN and dict(parse_qsl(url.query)) == {"token": f"tok-{started['anchor_tx_id']}", "callback": "postMessage"}
    method, path, form = anchor.requests[-1]
    assert (method, path) == ("POST", "/sep24/transactions/deposit/interactive")
    assert form == {
        "asset_code": "USDC", "asset_issuer": USDC_ISSUER, "account": kp.public_key, "amount": "5", "lang": "tr",
        "claimable_balance_supported": "false",
    }
    row = await db.get(AnchorTransaction, uuid.UUID(started["id"]))
    assert row is not None and row.anchor_tx_id == started["anchor_tx_id"] and row.status == "incomplete"
    assert row.interactive_url.endswith("&callback=postMessage") and row.asset_issuer == USDC_ISSUER

    # progression through the state machine
    tx_id = started["anchor_tx_id"]
    anchor.set_status(tx_id, "pending_user", message="E-posta doğrulaması bekleniyor")
    r = await client.get(f"{API}/anchor/transactions", headers=headers)
    assert r.status_code == 200, r.text
    listing = r.json()
    assert listing["synced"] is True and listing["auth_required"] is False and listing["total"] == 1
    item = listing["items"][0]
    assert item["status"] == "pending_user" and item["action"] == "open_interactive" and item["message"].startswith("E-posta")
    assert item["started_at"] is not None and item["is_terminal"] is False

    anchor.set_status(tx_id, "pending_anchor")
    anchor.set_status(tx_id, "completed", amount_in="5.0000000", amount_out="4.9000000", fee_details={"total": "0.1000000"},
                      stellar_transaction_id="a" * 64, completed_at=datetime.now(UTC).isoformat())
    r = await client.get(f"{API}/anchor/transactions/{tx_id}", headers=headers)  # by the anchor's id
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "completed" and done["is_terminal"] is True and done["action"] == "none"
    assert done["amount_in"] == "5.0000000" and done["amount_out"] == "4.9000000" and done["amount_fee"] == "0.1000000"
    assert done["stellar_tx_hash"] == "a" * 64 and done["completed_at"] is not None and done["status_label"] == "Tamamlandı"

    notes = (await db.execute(select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at))).scalars().all()
    types = [n.type for n in notes]
    assert "anchor_deposit_pending_user" in types and "anchor_deposit_completed" in types
    completed_note = next(n for n in notes if n.type == "anchor_deposit_completed")
    assert completed_note.category.value == "wallet" and completed_note.title == "Yatırma işlemi tamamlandı"
    assert completed_note.data["anchor_tx_id"] == tx_id and completed_note.data["action"] == "none"

    # terminal rows are not polled again
    before = len(anchor.requests)
    r = await client.get(f"{API}/anchor/transactions/{tx_id}", headers=headers)
    assert r.status_code == 200 and len(anchor.requests) == before
    # another user cannot see it
    _, tok2 = await make_user("trader")
    r = await client.get(f"{API}/anchor/transactions/{started['id']}", headers=auth_headers(tok2))
    assert r.status_code == 403 and r.json()["code"] == "not_owner"


async def test_native_deposit_needs_no_trustline_and_lists_from_anchor(client, db, make_user, auth_headers, horizon, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    horizon.fund(kp.public_key)
    await authenticate(client, headers, kp)
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={"asset_code": "XLM", "amount": "2.5"})
    assert r.status_code == 201, r.text
    assert r.json()["asset_code"] == "native" and r.json()["asset_issuer"] is None
    form = anchor.requests[-1][2]
    assert form["asset_code"] == "native" and "asset_issuer" not in form and form["lang"] == "tr"
    # a transaction started elsewhere (e.g. the anchor's own UI) is discovered through GET /transactions
    anchor.transactions["ext-1"] = {
        "id": "ext-1", "kind": "deposit", "status": "pending_anchor", "amount_in": "1.0000000", "amount_out": None,
        "amount_fee": None, "started_at": datetime.now(UTC).isoformat(), "_asset_code": "native",
    }
    r = await client.get(f"{API}/anchor/transactions", headers=headers, params={"kind": "deposit"})
    assert r.status_code == 200
    ids = {i["anchor_tx_id"]: i for i in r.json()["items"]}
    assert set(ids) == {"dep-1", "ext-1"} and ids["ext-1"]["status"] == "pending_anchor"
    assert ids["ext-1"]["asset_code"] == "native" and ids["ext-1"]["amount_in"] == "1.0000000"


# --- SEP-24 withdraw -------------------------------------------------------------------------------------


async def test_withdraw_builds_payment_with_exact_memo(client, db, settings, make_user, auth_headers, horizon, soroban, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    horizon.fund(kp.public_key)
    horizon.add_trustline(kp.public_key, "USDC", USDC_ISSUER)
    horizon.deposit_from_anchor(kp.public_key, "USDC", USDC_ISSUER, "8")
    horizon.fund(ANCHOR_ACCOUNT)
    horizon.add_trustline(ANCHOR_ACCOUNT, "USDC", USDC_ISSUER)
    soroban.link_horizon(horizon)
    await authenticate(client, headers, kp)

    r = await client.post(f"{API}/anchor/withdraw", headers=headers, json={"asset_code": "USDC", "amount": "9"})
    assert r.status_code == 400 and r.json()["code"] == "insufficient_funds"
    r = await client.post(f"{API}/anchor/withdraw", headers=headers, json={"asset_code": "USDC", "amount": "5"})
    assert r.status_code == 201, r.text
    started = r.json()
    assert started["kind"] == "withdraw" and "callback=" not in started["interactive_url"]  # only when asked
    tx_id = started["anchor_tx_id"]

    # the payment cannot be built before the anchor asks for it
    r = await client.post(f"{API}/anchor/transactions/{started['id']}/tx/payment", headers=headers)
    assert r.status_code == 409 and r.json()["code"] == "withdraw_not_ready"

    memo_raw = os.urandom(32)
    memo_b64 = base64.b64encode(memo_raw).decode()
    anchor.set_status(
        tx_id, "pending_user_transfer_start", amount_in="5.0000000", withdraw_anchor_account=ANCHOR_ACCOUNT,
        withdraw_memo=memo_b64, withdraw_memo_type="hash",
    )
    r = await client.post(f"{API}/anchor/transactions/{started['id']}/tx/payment", headers=headers)
    assert r.status_code == 200, r.text
    built = r.json()
    assert built["kind"] == "payment" and built["source"] == kp.public_key and built["agreement_id"] is None
    assert built["summary"]["destination"] == ANCHOR_ACCOUNT and built["summary"]["amount"] == "5.0000000"
    assert built["summary"]["memo"] == memo_b64 and built["summary"]["memo_type"] == "hash"
    env = TransactionEnvelope.from_xdr(built["unsigned_xdr"], built["network_passphrase"])
    assert env.transaction.source.account_id == kp.public_key and not env.signatures
    op = env.transaction.operations[0]
    assert isinstance(op, Payment) and op.destination.account_id == ANCHOR_ACCOUNT
    assert op.asset.code == "USDC" and op.asset.issuer == USDC_ISSUER and Decimal(op.amount) == Decimal("5")
    assert isinstance(env.transaction.memo, HashMemo) and env.transaction.memo.memo_hash == memo_raw
    pending = await db.get(PendingTransaction, uuid.UUID(built["pending_tx_id"]))
    assert pending is not None and pending.kind.value == "payment"
    ctx = pending.payload["context"]  # builder context lives under `context` (record_pending contract)
    assert ctx["anchor_tx_id"] == tx_id and ctx["purpose"] == "anchor_withdraw" and ctx["withdraw_memo_type"] == "hash"
    row = await db.get(AnchorTransaction, uuid.UUID(started["id"]))
    assert row.withdraw_memo == memo_b64 and row.withdraw_memo_type == "hash" and row.raw["payment_pending_tx_id"] == built["pending_tx_id"]
    listing = (await client.get(f"{API}/anchor/transactions", headers=headers)).json()["items"][0]
    assert listing["action"] == "send_payment" and listing["withdraw_anchor_account"] == ANCHOR_ACCOUNT

    # sign + submit through the shared /tx/submit: the classic payment reaches the (fake) ledger
    env.sign(kp)
    r = await client.post(f"{API}/tx/submit", headers=headers, json={"pending_tx_id": built["pending_tx_id"], "signed_xdr": env.to_xdr()})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "SUCCESS" and r.json()["kind"] == "payment"
    acct = await horizon.get_account(kp.public_key)
    assert acct.balance_of(_usdc()).balance == Decimal("3")
    paid = horizon.payments[-1]
    assert paid.destination == ANCHOR_ACCOUNT and paid.amount == Decimal("5") and paid.memo_type == "hash"

    anchor.set_status(tx_id, "completed", stellar_transaction_id=env.hash_hex(), completed_at=datetime.now(UTC).isoformat())
    r = await client.get(f"{API}/anchor/transactions/{started['id']}", headers=headers)
    assert r.json()["status"] == "completed" and r.json()["stellar_tx_hash"] == env.hash_hex()
    note = (await db.execute(select(Notification).where(Notification.type == "anchor_withdraw_completed"))).scalars().first()
    assert note is not None and note.title == "Çekim tamamlandı"


def _usdc():
    from app.services.stellar.types import AssetRef

    return AssetRef("USDC", USDC_ISSUER)


# --- re-auth (401/403) and the worker -----------------------------------------------------------------------


async def test_anchor_rejecting_the_session_forces_reauth(client, db, make_user, auth_headers, horizon, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    horizon.fund(kp.public_key)
    await authenticate(client, headers, kp)
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={"asset_code": "native", "amount": "1"})
    assert r.status_code == 201

    anchor.reject_auth = True  # the anchor's JWT lifetime ended (gotcha #11): 401 / 403 both mean re-auth
    r = await client.get(f"{API}/anchor/transactions", headers=headers)
    assert r.status_code == 200
    assert r.json()["synced"] is False and r.json()["auth_required"] is True and r.json()["total"] == 1
    assert (await db.execute(select(AnchorSession).where(AnchorSession.user_id == user.id))).scalar_one_or_none() is None
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={"asset_code": "native", "amount": "1"})
    assert r.status_code == 401 and r.json()["code"] == "anchor_auth_required"
    r = await client.get(f"{API}/anchor/auth/session", headers=headers)
    assert r.json()["authenticated"] is False
    # transparent recovery: SEP-10 again, then everything works
    anchor.reject_auth = False
    await authenticate(client, headers, kp)
    r = await client.get(f"{API}/anchor/transactions", headers=headers)
    assert r.json()["synced"] is True and r.json()["auth_required"] is False


async def test_worker_sync_progresses_and_flags_reauth(client, db, settings, make_user, auth_headers, horizon, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    horizon.fund(kp.public_key)
    horizon.add_trustline(kp.public_key, "USDC", USDC_ISSUER)
    await authenticate(client, headers, kp)
    r = await client.post(f"{API}/anchor/deposit", headers=headers, json={"asset_code": "USDC", "amount": "3"})
    tx_id = r.json()["anchor_tx_id"]
    r = await client.post(f"{API}/anchor/withdraw", headers=headers, json={"asset_code": "native", "amount": "1"})
    wd_id = r.json()["anchor_tx_id"]

    worker_client = AnchorClient(settings, domain=DOMAIN)
    anchor.set_status(tx_id, "pending_trust")
    res = await run_anchor_sync_once(db, settings, client=worker_client)
    await db.commit()
    assert (res.users, res.checked, res.updated, res.failed, res.reauth_needed) == (1, 2, 1, 0, 0)
    rows = {t.anchor_tx_id: t for t in (await db.execute(select(AnchorTransaction))).scalars().all()}
    assert rows[tx_id].status == "pending_trust" and rows[wd_id].status == "incomplete"
    note = (await db.execute(select(Notification).where(Notification.type == "anchor_deposit_pending_trust"))).scalars().one()
    assert note.data["action"] == "add_trustline" and note.title == "Trustline gerekli"

    # session expired server-side (anchor-chosen JWT lifetime): the worker cannot sign for the user
    session = (await db.execute(select(AnchorSession).where(AnchorSession.user_id == user.id))).scalar_one()
    session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()
    anchor.set_status(tx_id, "completed")
    res = await run_anchor_sync_once(db, settings, client=worker_client)
    await db.commit()
    assert res.reauth_needed == 2 and res.checked == 0
    db.expire_all()
    rows = {t.anchor_tx_id: t for t in (await db.execute(select(AnchorTransaction))).scalars().all()}
    assert rows[tx_id].status == "pending_trust" and rows[tx_id].raw["needs_reauth"] is True
    reauth_notes = (await db.execute(select(Notification).where(Notification.type == "anchor_reauth_required"))).scalars().all()
    assert len(reauth_notes) == 1 and reauth_notes[0].data["count"] == 2  # once per batch, not per row
    r = await client.get(f"{API}/anchor/transactions/{tx_id}", headers=headers)
    assert r.json()["needs_reauth"] is True
    # second pass: no duplicate notification
    res = await run_anchor_sync_once(db, settings, client=worker_client)
    await db.commit()
    assert res.reauth_needed == 0
    assert len((await db.execute(select(Notification).where(Notification.type == "anchor_reauth_required"))).scalars().all()) == 1

    # user re-authenticates -> the worker catches up and clears the flag
    await authenticate(client, headers, kp)
    res = await run_anchor_sync_once(db, settings, client=worker_client)
    await db.commit()
    db.expire_all()
    rows = {t.anchor_tx_id: t for t in (await db.execute(select(AnchorTransaction))).scalars().all()}
    assert res.updated == 1 and rows[tx_id].status == "completed" and "needs_reauth" not in rows[tx_id].raw
    assert rows[wd_id].status == "incomplete" and "needs_reauth" not in rows[wd_id].raw


# --- SEP-12 ---------------------------------------------------------------------------------------------------


async def test_kyc_passthrough(client, make_user, auth_headers, anchor: FakeAnchor):
    kp = Keypair.random()
    user, tok = await make_user("customer", keypair=kp)
    headers = auth_headers(tok)
    r = await client.post(f"{API}/anchor/kyc", headers=headers, json={"fields": {"first_name": "Ayşe"}})
    assert r.status_code == 401 and r.json()["code"] == "anchor_auth_required"
    await authenticate(client, headers, kp)
    r = await client.post(
        f"{API}/anchor/kyc", headers=headers,
        json={"fields": {"first_name": "Ayşe", "last_name": "Yılmaz", "email_address": "ayse@example.com"}, "type": "sep24-customer"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["customer_id"] == "cust-1" and body["status"] == "ACCEPTED"
    assert set(body["provided_fields"]) == {"first_name", "last_name", "email_address"}
    put = next(req for req in anchor.requests if req[1] == "/sep12/customer")
    assert put[2] == {"first_name": "Ayşe", "last_name": "Yılmaz", "email_address": "ayse@example.com", "type": "sep24-customer"}
    r = await client.post(f"{API}/anchor/kyc", headers=headers, json={"fields": {}})
    assert r.status_code == 422


async def test_anchor_disabled(client, make_user, auth_headers, anchor: FakeAnchor, monkeypatch):
    user, tok = await make_user("customer")
    monkeypatch.setattr(get_settings(), "anchor_enabled", False)
    try:
        r = await client.get(f"{API}/anchor/info", headers=auth_headers(tok))
        assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["assets"] == []
        r = await client.post(f"{API}/anchor/auth/challenge", headers=auth_headers(tok), json={})
        assert r.status_code == 409 and r.json()["code"] == "anchor_disabled"
    finally:
        monkeypatch.setattr(get_settings(), "anchor_enabled", True)
