"""Shared helpers for the agreements / trading / indexer tests (not collected by pytest).

* `soroban_gateway()`: body for a per-module `soroban` fixture override — a `FakeSorobanGateway` whose
  ledger clock starts at the real wall clock, so trade deadlines / expiry computed by the services from
  `time.time()` line up with the fake contract.
* `_fx_stub`: pins the USD/TRY rate so TL equivalents never hit the network.
* row factories and signing helpers.
"""
from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from stellar_sdk import Keypair, TransactionEnvelope

from app.models import Agreement, AgreementStatus, Asset, User, UserRole
from app.services import fx
from app.services.agreements import build_terms, compute_listing_ref, reset_price_cache
from app.services.stellar import set_soroban
from app.services.stellar.fake import FakeSorobanGateway
from app.services.stellar.types import TxResult, UnsignedTx
from tests.test_auth import mount_routers

ROUTERS = ("agreements", "tx", "trades", "activity")
API = "/api/v1"
FX_RATE = Decimal("41.5000000")


@pytest.fixture(scope="module", autouse=True)
def _mounted() -> None:
    mount_routers(ROUTERS)


def soroban_gateway() -> Iterator[FakeSorobanGateway]:
    """Body of the per-module `soroban` fixture: `yield from soroban_gateway()`."""
    gw = FakeSorobanGateway(now=int(time.time()))
    set_soroban(gw)
    try:
        yield gw
    finally:
        set_soroban(None)


@pytest.fixture(autouse=True)
def _fx_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    rate = fx.FxRate(rate=FX_RATE, source="test", fetched_at=datetime.now(UTC))

    async def fake_get_usd_try(settings: Any, db: Any = None, **kw: Any) -> fx.FxRate:
        return rate

    monkeypatch.setattr(fx, "get_usd_try", fake_get_usd_try)
    reset_price_cache()


# --- rows -------------------------------------------------------------------------------------------


async def make_agreement(
    db: AsyncSession,
    customer: User,
    trader: User,
    base_asset: Asset,
    *,
    principal: Decimal | str = Decimal("1000"),
    duration_days: int = 7,
    commission_bps: int = 2000,
    max_drawdown_bps: int = 1000,
    proposer_role: UserRole = UserRole.customer,
    status: AgreementStatus = AgreementStatus.draft,
    **kw: Any,
) -> Agreement:
    """A draft (or given-status) agreement row like the offers slice creates on accept. Committed."""
    ag_id = uuid.uuid4()
    ag = Agreement(
        id=ag_id,
        customer_id=customer.id,
        trader_id=trader.id,
        base_asset_id=base_asset.id,
        principal=Decimal(str(principal)),
        duration_secs=duration_days * 86_400,
        commission_bps=commission_bps,
        max_drawdown_bps=max_drawdown_bps,
        listing_ref=compute_listing_ref(ag_id),
        status=status,
        proposer_role=proposer_role,
        **kw,
    )
    db.add(ag)
    await db.commit()
    await db.refresh(ag)
    return ag


# --- signing / submitting ---------------------------------------------------------------------------


def sign_xdr(xdr: str, network_passphrase: str, kp: Keypair) -> str:
    env = TransactionEnvelope.from_xdr(xdr, network_passphrase)
    env.sign(kp)
    return env.to_xdr()


async def api_submit(client: AsyncClient, headers: dict[str, str], built: dict[str, Any], kp: Keypair) -> dict[str, Any]:
    """Sign what `POST .../tx/{action}` returned and `POST /tx/submit` it (asserts HTTP 200)."""
    signed = sign_xdr(built["unsigned_xdr"], built["network_passphrase"], kp)
    r = await client.post(f"{API}/tx/submit", json={"pending_tx_id": built["pending_tx_id"], "signed_xdr": signed}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def api_action(
    client: AsyncClient, headers: dict[str, str], agreement_id: uuid.UUID | str, action: str, kp: Keypair, body: dict | None = None
) -> dict[str, Any]:
    """Build + sign + submit one lifecycle action through the API; returns the submit response."""
    r = await client.post(f"{API}/agreements/{agreement_id}/tx/{action}", json=body, headers=headers)
    assert r.status_code == 200, r.text
    built = r.json()
    return await api_submit(client, headers, built, kp)


async def chain_submit(gw: FakeSorobanGateway, unsigned: UnsignedTx, kp: Keypair) -> TxResult:
    """Sign + send directly on the fake (bypasses the API, like a wallet talking to the contract)."""
    tx_hash = await gw.send(sign_xdr(unsigned.xdr, unsigned.network_passphrase, kp))
    res = await gw.poll_tx(tx_hash, 1)
    assert res.ok, res
    return res


async def chain_open_and_accept(gw: FakeSorobanGateway, ag: Agreement, customer_kp: Keypair, trader_kp: Keypair) -> int:
    """customer `open` + trader `accept` straight on the fake contract; returns the on-chain id."""
    res = await chain_submit(gw, await gw.build_open(customer_kp.public_key, build_terms(ag)), customer_kp)
    onchain_id = int(res.return_value)
    await chain_submit(gw, await gw.build_accept(trader_kp.public_key, onchain_id), trader_kp)
    return onchain_id
