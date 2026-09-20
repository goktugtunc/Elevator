"""Live testnet checks for SorobanGateway (skipped unless LIVE_STELLAR=1).

    LIVE_STELLAR=1 scripts/dev.sh test tests/test_soroban_live.py -q -s
"""
from __future__ import annotations

import os

import pytest

from app.core.config import get_settings
from app.services.stellar.soroban import SorobanGateway

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("LIVE_STELLAR") != "1", reason="set LIVE_STELLAR=1 to hit Stellar testnet"),
]

ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
USDC = "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F"


@pytest.fixture
async def gw():
    settings = get_settings()
    assert settings.stellar_network == "testnet"
    g = SorobanGateway(settings)
    g.router_id = ROUTER
    try:
        yield g
    finally:
        await g.close()


async def test_latest_ledger(gw: SorobanGateway):
    ledger = await gw.latest_ledger()
    assert ledger > 4_000_000
    print(f"\n[live] testnet latest ledger = {ledger}")


async def test_router_quote_xlm_to_usdc(gw: SorobanGateway):
    amount_in = 10_000_000  # 1 XLM
    out = await gw.router_quote(XLM, USDC, amount_in)
    assert 0 < out < amount_in  # 1 XLM is worth a fraction of a USDC
    amounts = await gw.router_amounts_out(amount_in, [XLM, USDC])
    assert amounts[0] == amount_in and amounts[-1] == out
    q = await gw.quote(XLM, USDC, amount_in)
    assert q.amount_out == out and q.source == "router"
    print(f"\n[live] Soroswap router quote: 1 XLM -> {out / 1e7:.7f} USDC (raw {out}) via {ROUTER}")


async def test_soroswap_api_quote_is_optional(gw: SorobanGateway):
    q = await gw.soroswap_api_quote(XLM, USDC, 10_000_000)
    if gw._settings.soroswap_api_key:
        print(f"\n[live] Soroswap API quote: {q}")
    else:
        assert q is None


async def test_token_balance_of_unfunded_account_is_zero(gw: SorobanGateway):
    from stellar_sdk import Keypair

    assert await gw.token_balance(XLM, Keypair.random().public_key) == 0


async def test_vault_reads_when_deployed(gw: SorobanGateway):
    settings = get_settings()
    if not settings.vault_contract_id:
        pytest.skip("VAULT_CONTRACT_ID not set yet")
    cfg = await gw.get_config()
    assert cfg.router == settings.effective_soroswap_router_id
    nid = await gw.next_id()
    assert nid >= 1
    print(f"\n[live] vault {settings.vault_contract_id}: config={cfg.as_dict()} next_id={nid}")


async def test_get_events_and_get_transaction_meta_parsing(gw: SorobanGateway):
    """getEvents on the Soroswap router + getTransaction of one of those txs (meta V4 parsing)."""
    latest = await gw.latest_ledger()
    events, cursor, seen_latest = await gw.get_events(start_ledger=max(1, latest - 4000), contract_id=ROUTER, limit=20)
    assert seen_latest >= latest - 1
    if not events:
        pytest.skip("no router events in the last ~4000 ledgers")
    ev = events[0]
    assert ev.contract_id == ROUTER and ev.tx_hash and ev.topics_xdr and cursor
    # paging with the returned cursor never re-delivers the same event
    more, _, _ = await gw.get_events(cursor=cursor, contract_id=ROUTER, limit=5)
    assert all(m.id > cursor for m in more)
    res = await gw.get_transaction(ev.tx_hash)
    assert res.ok and res.ledger == ev.ledger and res.result_meta_xdr
    assert any(e.contract_id == ROUTER for e in res.events)  # contract events extracted from meta
    print(f"\n[live] router events: {len(events)} (first id {ev.id}, tx {ev.tx_hash[:12]}...), tx events parsed: {len(res.events)}")


async def test_build_invoke_and_classic_builders(gw: SorobanGateway):
    """Simulate + assemble with a real funded source (the platform account); nothing is submitted."""
    from stellar_sdk import Keypair, TransactionEnvelope
    from stellar_sdk.operation import ChangeTrust, InvokeHostFunction, Payment

    from app.services.stellar import contract_abi as abi

    settings = get_settings()
    source = Keypair.from_secret(settings.platform_secret).public_key
    if not await gw.account_exists(source):
        pytest.skip("platform account is not funded on testnet")
    unsigned = await gw.build_invoke(
        ROUTER, "router_get_amounts_out", abi.args_router_amounts_out(10_000_000, [XLM, USDC]), source, kind="quote"
    )
    env = TransactionEnvelope.from_xdr(unsigned.xdr, unsigned.network_passphrase)
    assert env.transaction.source.account_id == source and not env.signatures
    assert isinstance(env.transaction.operations[0], InvokeHostFunction)
    assert env.transaction.soroban_data is not None  # assembled: footprint + resource fee
    assert unsigned.hash == env.hash_hex() and unsigned.summary["simulated_result"][-1] > 0
    assert unsigned.expires_at.timestamp() > unsigned.summary["fee_stroops"] > 0
    print(f"\n[live] assembled invoke: fee={unsigned.summary['fee_stroops']} stroops, result={unsigned.summary['simulated_result']}")

    pay = await gw.build_payment(source, Keypair.random().public_key, "XLM", None, "1.5", memo="test", memo_type="text")
    penv = TransactionEnvelope.from_xdr(pay.xdr, pay.network_passphrase)
    assert pay.summary["operation"] == "create_account"  # destination does not exist yet
    existing = await gw.build_payment(source, "GCJORJA5Z3N52UIXGHFSYVGTRPF2NEQVD6S7I53P3PQ5SKVUM4EUBT7N", "XLM", None, "0.1")
    assert isinstance(TransactionEnvelope.from_xdr(existing.xdr, existing.network_passphrase).transaction.operations[0], Payment)
    assert penv.transaction.source.account_id == source
    trust = await gw.build_change_trust(source, "USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")
    assert isinstance(TransactionEnvelope.from_xdr(trust.xdr, trust.network_passphrase).transaction.operations[0], ChangeTrust)
    with pytest.raises(Exception) as ei:
        await gw.build_payment(Keypair.random().public_key, source, "XLM", None, "1")
    assert getattr(ei.value, "code", "") == "account_not_found"
