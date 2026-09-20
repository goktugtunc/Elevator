"""FakeSorobanGateway / FakeHorizonGateway: the in-memory state machine must behave like the contract
(lifecycle, auth, allow-list, drawdown, slippage, expiry, settle math) and the XDR it hands out must be a
real unsigned envelope the user could sign."""
from __future__ import annotations

from decimal import Decimal

import pytest
from stellar_sdk import Account, Asset, Keypair, TransactionBuilder, TransactionEnvelope
from stellar_sdk.operation import InvokeHostFunction, Payment
from stellar_sdk.strkey import StrKey

from app.core.errors import StellarError, ValidationError
from app.services import amounts as money
from app.services.stellar.contract_abi import (
    ActivatedEvent,
    CancelledEvent,
    OpenedEvent,
    ProposedEvent,
    SettledEvent,
    Status,
    Terms,
    TradedEvent,
    VaultContractError,
    VaultError,
)
from app.services.stellar.fake import (
    FAKE_ADMIN,
    TESTNET_CIRCLE_USDC,
    TESTNET_EURC,
    TESTNET_USDC,
    TESTNET_XLM,
    FakeAuthError,
    FakeHorizonGateway,
    FakeSorobanGateway,
)
from app.services.stellar.types import AccountNotFoundError, AssetRef, TxRejectedError

CUSTOMER_KP = Keypair.from_raw_ed25519_seed(bytes([11]) * 32)
TRADER_KP = Keypair.from_raw_ed25519_seed(bytes([22]) * 32)
OTHER_KP = Keypair.from_raw_ed25519_seed(bytes([33]) * 32)
CUSTOMER, TRADER, OTHER = CUSTOMER_KP.public_key, TRADER_KP.public_key, OTHER_KP.public_key
PRINCIPAL = 1_000_0000000  # 1000 XLM


def rand_contract() -> str:
    import os

    return StrKey.encode_contract(os.urandom(32))


def terms(**kw) -> Terms:
    base = dict(
        customer=CUSTOMER,
        trader=TRADER,
        base_token=TESTNET_XLM,
        principal=PRINCIPAL,
        duration_secs=7 * 86_400,
        commission_bps=2000,
        max_drawdown_bps=1000,
        listing_ref=bytes([7]) * 32,
    )
    base.update(kw)
    return Terms(**base)


def sign(unsigned, kp: Keypair) -> str:
    env = TransactionEnvelope.from_xdr(unsigned.xdr, unsigned.network_passphrase)
    env.sign(kp)
    return env.to_xdr()


async def submit(gw: FakeSorobanGateway, unsigned, kp: Keypair):
    tx_hash = await gw.send(sign(unsigned, kp))
    assert tx_hash == unsigned.hash  # signing does not change the hash
    return await gw.poll_tx(tx_hash, 1)


@pytest.fixture
def gw() -> FakeSorobanGateway:
    g = FakeSorobanGateway()
    g.fund_wallet(CUSTOMER, TESTNET_XLM, 10 * PRINCIPAL)
    return g


# --- customer-initiated lifecycle -------------------------------------------------------------


async def test_open_accept_trade_settle_lifecycle(gw: FakeSorobanGateway):
    # open (customer funds)
    unsigned = await gw.build_open(CUSTOMER, terms())
    env = TransactionEnvelope.from_xdr(unsigned.xdr, unsigned.network_passphrase)
    assert env.transaction.source.account_id == CUSTOMER and len(env.signatures) == 0
    op = env.transaction.operations[0]
    assert isinstance(op, InvokeHostFunction)
    assert unsigned.summary["function"] == "open" and unsigned.summary["simulated_result"] == 1
    assert unsigned.kind == "open" and unsigned.summary["terms"]["principal"] == PRINCIPAL

    res = await submit(gw, unsigned, CUSTOMER_KP)
    assert res.ok and res.return_value == 1
    assert [type(e.decoded) for e in res.events] == [OpenedEvent]
    ag = await gw.get_agreement(1)
    assert ag.status is Status.Funded and ag.proposer == CUSTOMER and ag.tokens == [TESTNET_XLM]
    assert await gw.get_balances(1) == [(TESTNET_XLM, PRINCIPAL)]
    assert gw.wallet_balance(CUSTOMER, TESTNET_XLM) == 9 * PRINCIPAL
    assert await gw.next_id() == 2

    # accept (trader)
    res = await submit(gw, await gw.build_accept(TRADER, 1), TRADER_KP)
    assert res.ok and isinstance(res.events[0].decoded, ActivatedEvent)
    ag = await gw.get_agreement(1)
    assert ag.status is Status.Active and ag.start_time == gw.now and ag.end_time == gw.now + 7 * 86_400

    # trade XLM -> USDC (price 0.29)
    amount_in = 100_0000000
    quote = await gw.router_quote(TESTNET_XLM, TESTNET_USDC, amount_in)
    assert quote == 29_0000000
    min_out = money.min_out_for_slippage(quote, 100)
    unsigned = await gw.build_trade(TRADER, 1, TESTNET_XLM, TESTNET_USDC, amount_in, min_out, gw.now + 300)
    assert unsigned.summary["simulated_result"] == quote
    res = await submit(gw, unsigned, TRADER_KP)
    traded = res.events[0].decoded
    assert isinstance(traded, TradedEvent)
    assert traded.amount_in == amount_in and traded.amount_out == quote and traded.trader == TRADER
    assert await gw.get_balances(1) == [(TESTNET_XLM, PRINCIPAL - amount_in), (TESTNET_USDC, quote)]
    assert await gw.value_in_base(1) == PRINCIPAL - amount_in + int(quote / Decimal("0.29"))
    assert traded.value_after == await gw.value_in_base(1)

    # price moves up: USDC now worth more XLM -> profit
    gw.set_price(TESTNET_XLM, TESTNET_USDC, "0.20")  # 1 USDC = 5 XLM
    value = await gw.value_in_base(1)
    assert value > PRINCIPAL
    # settle by customer (any time), min_outs per non-base token
    usdc_bal = dict(await gw.get_balances(1))[TESTNET_USDC]
    q = await gw.router_quote(TESTNET_USDC, TESTNET_XLM, usdc_bal)
    res = await submit(gw, await gw.build_settle(CUSTOMER, 1, [money.min_out_for_slippage(q, 100)]), CUSTOMER_KP)
    assert res.ok
    settled = res.events[0].decoded
    assert isinstance(settled, SettledEvent) and settled.by == CUSTOMER
    final_value = PRINCIPAL - amount_in + q
    expected = money.settle_math(final_value, PRINCIPAL, 2000, 0)
    assert settled.final_value == expected.final_value == final_value
    assert settled.profit == expected.profit and settled.trader_fee == expected.trader_fee
    assert settled.customer_payout == expected.customer_payout and settled.platform_fee == 0
    assert settled.customer_payout + settled.trader_fee + settled.platform_fee == final_value
    ag = await gw.get_agreement(1)
    assert ag.status is Status.Settled and ag.final_value == final_value and ag.trader_fee == expected.trader_fee
    assert ag.tokens == [TESTNET_XLM] and await gw.get_balances(1) == [(TESTNET_XLM, 0)]
    assert gw.wallet_balance(TRADER, TESTNET_XLM) == expected.trader_fee
    assert gw.wallet_balance(CUSTOMER, TESTNET_XLM) == 9 * PRINCIPAL + expected.customer_payout

    # after settlement nothing else is allowed
    with pytest.raises(VaultContractError) as ei:
        await gw.build_trade(TRADER, 1, TESTNET_XLM, TESTNET_USDC, 1, 1, gw.now + 10)
    assert ei.value.error is VaultError.WrongStatus

    # indexer view: events in order, cursor pagination
    events, cursor, latest = await gw.get_events(start_ledger=0, limit=2)
    assert [type(e.decoded) for e in events] == [OpenedEvent, ActivatedEvent] and latest == gw.ledger
    more, cursor2, _ = await gw.get_events(cursor=cursor, limit=10)
    assert [type(e.decoded) for e in more] == [TradedEvent, SettledEvent]
    assert cursor2 == more[-1].id
    none, cursor3, _ = await gw.get_events(cursor=cursor2)
    assert none == [] and cursor3 == cursor2
    # every event decodes through the production decoder from its XDR
    from app.services.stellar.contract_abi import decode_event

    for e in events + more:
        assert decode_event(e.topics_xdr, e.value_xdr) == e.decoded


async def test_settle_with_loss_and_platform_fee(gw: FakeSorobanGateway):
    gw.set_fees(100, OTHER)  # 1% platform fee to OTHER
    await submit(gw, await gw.build_open(CUSTOMER, terms(max_drawdown_bps=10_000)), CUSTOMER_KP)
    await submit(gw, await gw.build_accept(TRADER, 1), TRADER_KP)
    q = await gw.router_quote(TESTNET_XLM, TESTNET_USDC, 500_0000000)
    await submit(gw, await gw.build_trade(TRADER, 1, TESTNET_XLM, TESTNET_USDC, 500_0000000, q, gw.now + 60), TRADER_KP)
    gw.set_price(TESTNET_XLM, TESTNET_USDC, "0.40")  # USDC lost value vs XLM -> loss
    usdc = dict(await gw.get_balances(1))[TESTNET_USDC]
    back = await gw.router_quote(TESTNET_USDC, TESTNET_XLM, usdc)
    res = await submit(gw, await gw.build_settle(TRADER, 1, [back]), TRADER_KP)  # trader may settle too
    settled = res.events[0].decoded
    final_value = 500_0000000 + back
    assert final_value < PRINCIPAL
    assert settled.profit == 0 and settled.trader_fee == 0 and settled.platform_fee == 0
    assert settled.customer_payout == final_value
    assert gw.wallet_balance(OTHER, TESTNET_XLM) == 0

    # profit case with platform fee
    gw.fund_wallet(CUSTOMER, TESTNET_XLM, PRINCIPAL)
    await submit(gw, await gw.build_open(CUSTOMER, terms()), CUSTOMER_KP)
    await submit(gw, await gw.build_accept(TRADER, 2), TRADER_KP)
    q = await gw.router_quote(TESTNET_XLM, TESTNET_USDC, 500_0000000)
    await submit(gw, await gw.build_trade(TRADER, 2, TESTNET_XLM, TESTNET_USDC, 500_0000000, q, gw.now + 60), TRADER_KP)
    gw.set_price(TESTNET_XLM, TESTNET_USDC, "0.10")
    usdc = dict(await gw.get_balances(2))[TESTNET_USDC]
    back = await gw.router_quote(TESTNET_USDC, TESTNET_XLM, usdc)
    res = await submit(gw, await gw.build_settle(CUSTOMER, 2, [0]), CUSTOMER_KP)
    settled = res.events[0].decoded
    exp = money.settle_math(500_0000000 + back, PRINCIPAL, 2000, 100)
    assert (settled.trader_fee, settled.platform_fee, settled.customer_payout) == (exp.trader_fee, exp.platform_fee, exp.customer_payout)
    assert gw.wallet_balance(OTHER, TESTNET_XLM) == exp.platform_fee
    assert settled.trader_fee + settled.platform_fee <= settled.profit


# --- trader-initiated lifecycle + cancel ----------------------------------------------------------


async def test_propose_fund_and_cancel_paths(gw: FakeSorobanGateway):
    unsigned = await gw.build_propose(TRADER, terms())
    res = await submit(gw, unsigned, TRADER_KP)
    assert isinstance(res.events[0].decoded, ProposedEvent) and res.return_value == 1
    ag = await gw.get_agreement(1)
    assert ag.status is Status.Proposed and ag.proposer == TRADER
    assert await gw.get_balances(1) == [(TESTNET_XLM, 0)]

    # only the proposer may cancel a Proposed agreement
    with pytest.raises(VaultContractError) as ei:
        await gw.build_cancel(CUSTOMER, 1)
    assert ei.value.error is VaultError.NotParty
    # accept is the wrong action for Proposed
    with pytest.raises(VaultContractError) as ei:
        await gw.build_accept(TRADER, 1)
    assert ei.value.error is VaultError.WrongStatus

    # customer funds -> Active
    res = await submit(gw, await gw.build_fund(CUSTOMER, 1), CUSTOMER_KP)
    assert isinstance(res.events[0].decoded, ActivatedEvent)
    assert (await gw.get_agreement(1)).status is Status.Active
    assert gw.wallet_balance(CUSTOMER, TESTNET_XLM) == 9 * PRINCIPAL
    with pytest.raises(VaultContractError) as ei:  # active agreements cannot be cancelled
        await gw.build_cancel(CUSTOMER, 1)
    assert ei.value.error is VaultError.WrongStatus

    # second: proposed then cancelled by the proposer (no refund)
    await submit(gw, await gw.build_propose(TRADER, terms()), TRADER_KP)
    res = await submit(gw, await gw.build_cancel(TRADER, 2), TRADER_KP)
    assert res.events[0].decoded == CancelledEvent(id=2, refunded=0)
    assert (await gw.get_agreement(2)).status is Status.Cancelled

    # third: opened (funded) then cancelled by the trader -> refund to customer
    await submit(gw, await gw.build_open(CUSTOMER, terms()), CUSTOMER_KP)
    before = gw.wallet_balance(CUSTOMER, TESTNET_XLM)
    res = await submit(gw, await gw.build_cancel(TRADER, 3), TRADER_KP)
    assert res.events[0].decoded == CancelledEvent(id=3, refunded=PRINCIPAL)
    assert gw.wallet_balance(CUSTOMER, TESTNET_XLM) == before + PRINCIPAL
    assert await gw.get_balances(3) == [(TESTNET_XLM, 0)]

    with pytest.raises(VaultContractError) as ei:
        await gw.get_agreement(99)
    assert ei.value.error is VaultError.NotFound


# --- rules ---------------------------------------------------------------------------------------


async def test_auth_and_terms_rules(gw: FakeSorobanGateway):
    with pytest.raises(VaultContractError) as ei:
        await gw.build_open(TRADER, terms())  # source must equal terms.customer
    assert ei.value.error is VaultError.Unauthorized
    with pytest.raises(VaultContractError) as ei:
        await gw.build_open(CUSTOMER, terms(base_token=TESTNET_EURC))  # EURC is allowed but not a base
    assert ei.value.error is VaultError.TokenNotAllowed
    with pytest.raises(VaultContractError) as ei:
        await gw.build_open(CUSTOMER, terms(commission_bps=6000))
    assert ei.value.error is VaultError.InvalidTerms
    await submit(gw, await gw.build_open(CUSTOMER, terms()), CUSTOMER_KP)
    with pytest.raises(FakeAuthError):
        await gw.build_accept(OTHER, 1)  # not the trader -> host auth error, not a contract error
    with pytest.raises(FakeAuthError):
        await gw.build_fund(TRADER, 1)


async def test_strict_wallets_require_funds():
    g = FakeSorobanGateway(strict_wallets=True)
    with pytest.raises(StellarError) as ei:
        await g.build_open(CUSTOMER, terms())
    assert ei.value.code == "simulation_failed"
    g.fund_wallet(CUSTOMER, TESTNET_XLM, PRINCIPAL)
    await g.build_open(CUSTOMER, terms())


async def test_trade_rules(gw: FakeSorobanGateway):
    await submit(gw, await gw.build_open(CUSTOMER, terms()), CUSTOMER_KP)
    await submit(gw, await gw.build_accept(TRADER, 1), TRADER_KP)
    deadline = gw.now + 60

    async def expect(err: VaultError, *args):
        with pytest.raises(VaultContractError) as ei:
            await gw.build_trade(TRADER, 1, *args)
        assert ei.value.error is err

    await expect(VaultError.InvalidAmount, TESTNET_XLM, TESTNET_USDC, 0, 1, deadline)
    await expect(VaultError.InvalidAmount, TESTNET_XLM, TESTNET_USDC, 10, 0, deadline)
    await expect(VaultError.TokenNotAllowed, TESTNET_XLM, TESTNET_XLM, 10, 1, deadline)
    await expect(VaultError.TokenNotAllowed, TESTNET_XLM, rand_contract(), 10, 1, deadline)
    await expect(VaultError.InsufficientBalance, TESTNET_XLM, TESTNET_USDC, PRINCIPAL + 1, 1, deadline)
    await expect(VaultError.Expired, TESTNET_XLM, TESTNET_USDC, 10_0000000, 1, gw.now - 1)
    await expect(VaultError.RouterError, TESTNET_XLM, TESTNET_CIRCLE_USDC, 10_0000000, 1, deadline)  # no liquidity
    q = await gw.router_quote(TESTNET_XLM, TESTNET_USDC, 10_0000000)
    await expect(VaultError.SlippageExceeded, TESTNET_XLM, TESTNET_USDC, 10_0000000, q + 1, deadline)

    # drawdown: a route whose valuation back to base is poor (asymmetric prices) breaches 10%
    gw.set_price(TESTNET_XLM, TESTNET_EURC, "0.25", both_ways=False)
    gw.set_price(TESTNET_EURC, TESTNET_XLM, "2", both_ways=False)  # 1 EURC only worth 2 XLM on the way back
    q = await gw.router_quote(TESTNET_XLM, TESTNET_EURC, 500_0000000)
    await expect(VaultError.DrawdownBreached, TESTNET_XLM, TESTNET_EURC, 500_0000000, q, deadline)
    # ... and the failed dry run left nothing behind
    assert await gw.get_balances(1) == [(TESTNET_XLM, PRINCIPAL)]
    small = await gw.router_quote(TESTNET_XLM, TESTNET_EURC, 100_0000000)
    await submit(gw, await gw.build_trade(TRADER, 1, TESTNET_XLM, TESTNET_EURC, 100_0000000, small, deadline), TRADER_KP)

    # MAX_TOKENS bound: allow 5 more tokens
    extra = [rand_contract() for _ in range(5)]
    for fake_token in extra:
        gw.set_token(fake_token, True, False)
        gw.set_price(TESTNET_XLM, fake_token, "1")
    for t in extra[:4]:
        await submit(gw, await gw.build_trade(TRADER, 1, TESTNET_XLM, t, 1_0000000, 1, deadline), TRADER_KP)
    assert len((await gw.get_agreement(1)).tokens) == 6
    await expect(VaultError.TooManyTokens, TESTNET_XLM, extra[4], 1_0000000, 1, deadline)
    # selling a whole non-base holding frees the slot
    await submit(gw, await gw.build_trade(TRADER, 1, extra[0], TESTNET_XLM, 1_0000000, 1, deadline), TRADER_KP)
    assert extra[0] not in (await gw.get_agreement(1)).tokens

    # expiry blocks trading, pause too
    gw.advance(8 * 86_400)
    await expect(VaultError.Expired, TESTNET_XLM, TESTNET_USDC, 1_0000000, 1, gw.now + 10)
    gw.advance(-8 * 86_400)
    gw.set_paused(True)
    await expect(VaultError.Paused, TESTNET_XLM, TESTNET_USDC, 1_0000000, 1, gw.now + 10)
    with pytest.raises(VaultContractError) as ei:
        await gw.build_open(CUSTOMER, terms())
    assert ei.value.error is VaultError.Paused


async def test_settle_rules_and_permissionless_after_expiry(gw: FakeSorobanGateway):
    await submit(gw, await gw.build_open(CUSTOMER, terms()), CUSTOMER_KP)
    with pytest.raises(VaultContractError) as ei:
        await gw.build_settle(CUSTOMER, 1, [])
    assert ei.value.error is VaultError.WrongStatus  # Funded, not Active
    await submit(gw, await gw.build_accept(TRADER, 1), TRADER_KP)
    q = await gw.router_quote(TESTNET_XLM, TESTNET_USDC, 100_0000000)
    await submit(gw, await gw.build_trade(TRADER, 1, TESTNET_XLM, TESTNET_USDC, 100_0000000, q, gw.now + 60), TRADER_KP)

    with pytest.raises(VaultContractError) as ei:
        await gw.build_settle(CUSTOMER, 1, [])  # one min_out per non-base token
    assert ei.value.error is VaultError.InvalidAmount
    with pytest.raises(VaultContractError) as ei:
        await gw.build_settle(CUSTOMER, 1, [10**18])
    assert ei.value.error is VaultError.SlippageExceeded
    with pytest.raises(VaultContractError) as ei:
        await gw.build_settle(OTHER, 1, [])  # third party before expiry
    assert ei.value.error is VaultError.NotExpired
    # build_settle always makes `caller` the tx source; a source/caller mismatch is a host auth error
    with pytest.raises(FakeAuthError):
        gw._do_settle(gw._state, 1, TRADER, [0], OTHER)

    gw.set_paused(True)  # pause never blocks settle
    gw.advance(8 * 86_400)
    res = await submit(gw, await gw.build_settle(OTHER, 1, []), OTHER_KP)  # anyone after end_time, min_outs ignored
    assert res.ok and res.events[0].decoded.by == OTHER
    ag = await gw.get_agreement(1)
    assert ag.status is Status.Settled and ag.settled_at == gw.now


async def test_send_unknown_and_state_change_between_build_and_send(gw: FakeSorobanGateway):
    await submit(gw, await gw.build_open(CUSTOMER, terms()), CUSTOMER_KP)
    accept = await gw.build_accept(TRADER, 1)
    cancel = await gw.build_cancel(CUSTOMER, 1)
    assert (await gw.simulate(accept.xdr)).ok
    await submit(gw, cancel, CUSTOMER_KP)
    # the accept was valid when built; on send the agreement is Cancelled -> tx FAILED (like on-chain)
    tx_hash = await gw.send(sign(accept, TRADER_KP))
    res = await gw.poll_tx(tx_hash)
    assert res.status == "FAILED" and res.contract_error_code == VaultError.WrongStatus
    sim = await gw.simulate(cancel.xdr)  # already consumed -> unknown
    assert not sim.ok
    foreign = (
        TransactionBuilder(Account(CUSTOMER, 5), gw.network_passphrase, base_fee=100)
        .append_payment_op(OTHER, Asset.native(), "1")
        .set_timeout(60)
        .build()
    )
    with pytest.raises(TxRejectedError):
        await gw.send(foreign.to_xdr())  # never built by this gateway
    assert (await gw.poll_tx("deadbeef")).pending
    assert await gw.send(sign(cancel, CUSTOMER_KP)) == cancel.hash  # re-sending a known tx == DUPLICATE


async def test_router_quotes_and_api_quote(gw: FakeSorobanGateway):
    assert await gw.router_quote(TESTNET_XLM, TESTNET_XLM, 5) == 5
    assert await gw.router_amounts_out(10_0000000, [TESTNET_XLM, TESTNET_USDC, TESTNET_EURC]) == [10_0000000, 2_9000000, 2_4940000]
    with pytest.raises(StellarError) as ei:
        await gw.router_quote(TESTNET_XLM, TESTNET_CIRCLE_USDC, 1)
    assert ei.value.code == "quote_failed"
    with pytest.raises(ValidationError):
        await gw.router_quote(TESTNET_XLM, TESTNET_USDC, 0)
    q = await gw.quote(TESTNET_XLM, TESTNET_USDC, 10_0000000)
    assert q.amount_out == 2_9000000 and q.source == "fake"
    assert await gw.soroswap_api_quote(TESTNET_XLM, TESTNET_USDC, 1) is None
    gw.api_quotes[(TESTNET_XLM, TESTNET_USDC)] = 2_9500000
    api = await gw.soroswap_api_quote(TESTNET_XLM, TESTNET_USDC, 1)
    assert api is not None and api.source == "api" and api.amount_out == 2_9500000
    assert (await gw.is_token_allowed(TESTNET_EURC)).allowed and not (await gw.is_token_allowed(TESTNET_EURC)).is_base
    assert (await gw.is_token_allowed(rand_contract())).allowed is False
    cfg = await gw.get_config()
    assert cfg.admin == FAKE_ADMIN and cfg.settle_slippage_bps == 100


async def test_admin_builders():
    admin_kp = Keypair.random()
    g = FakeSorobanGateway(admin=admin_kp.public_key)
    token = rand_contract()
    with pytest.raises(FakeAuthError):
        await g.build_set_token(OTHER, token, True, True)
    res = await submit(g, await g.build_set_token(admin_kp.public_key, token, True, True), admin_kp)
    assert res.ok and res.events[0].decoded.token == token and (await g.is_token_allowed(token)).is_base
    res = await submit(g, await g.build_set_paused(admin_kp.public_key, True), admin_kp)
    assert (await g.get_config()).paused and res.events[0].decoded.key == "paused"
    with pytest.raises(VaultContractError):
        await g.build_set_fees(admin_kp.public_key, 5000, OTHER)
    await submit(g, await g.build_set_fees(admin_kp.public_key, 100, OTHER), admin_kp)
    assert (await g.get_config()).platform_fee_bps == 100 and (await g.get_config()).fee_recipient == OTHER


# --- classic fakes ---------------------------------------------------------------------------------


async def test_fake_horizon_accounts_payments_and_anchor_deposit():
    h = FakeHorizonGateway()
    assert await h.get_account(CUSTOMER) is None
    await h.fund_with_friendbot(CUSTOMER)
    h.fund(OTHER, "50")
    info = await h.get_account(CUSTOMER)
    assert info is not None and info.balance_of(AssetRef.native()).balance == Decimal("10000")
    issuer = Keypair.random().public_key
    assert not await h.has_trustline(CUSTOMER, "USDC", issuer)
    with pytest.raises(TxRejectedError):
        h.deposit_from_anchor(CUSTOMER, "USDC", issuer, "25")
    # trustline via an unsigned change_trust built by the Soroban fake, applied through submit_xdr
    s = FakeSorobanGateway()
    s.link_horizon(h)
    trust = await s.build_change_trust(CUSTOMER, "USDC", issuer)
    assert trust.kind == "trustline"
    await s.send(sign(trust, CUSTOMER_KP))
    assert await h.has_trustline(CUSTOMER, "USDC", issuer)
    rec = h.deposit_from_anchor(CUSTOMER, "USDC", issuer, "25", memo="dep-1")
    assert rec.asset == AssetRef("USDC", issuer) and rec.amount == Decimal("25") and rec.memo == "dep-1"
    assert (await h.get_account(CUSTOMER)).balance_of(AssetRef("USDC", issuer)).balance == Decimal("25")

    # payment history + cursor
    recs, cursor = await h.fetch_payments(CUSTOMER, None)
    assert [r.op_type for r in recs] == ["create_account", "payment"]
    again, cursor2 = await h.fetch_payments(CUSTOMER, cursor)
    assert again == [] and cursor2 == cursor

    # classic payment built by the Horizon fake, signed by the user, submitted
    xdr = await h.build_payment_xdr(CUSTOMER, OTHER, AssetRef.native(), Decimal("12.5"), "hello")
    src, dest, asset, amount, memo = h.parse_payment_xdr(xdr)
    assert (src, dest, asset, amount, memo) == (CUSTOMER, OTHER, AssetRef.native(), Decimal("12.5"), "hello")
    env = TransactionEnvelope.from_xdr(xdr, h.network_passphrase)
    assert isinstance(env.transaction.operations[0], Payment)
    env.sign(CUSTOMER_KP)
    result = await h.submit_xdr(env.to_xdr())
    assert result.successful and result.hash == env.hash_hex()
    assert (await h.get_transaction(result.hash)) == result
    assert (await h.get_account(OTHER)).balance_of(AssetRef.native()).balance == Decimal("62.5")
    recs, _ = await h.fetch_payments(OTHER, None)
    assert recs[-1].memo == "hello" and recs[-1].source_account == CUSTOMER

    # failure modes mirror Horizon result codes
    with pytest.raises(TxRejectedError) as ei:
        await h.submit_xdr(sign(await s.build_payment(CUSTOMER, OTHER, "USDC", issuer, "1"), CUSTOMER_KP))
    assert ei.value.details["result_codes"]["operations"] == ["op_no_trust"]
    nobody = Keypair.random().public_key
    with pytest.raises(AccountNotFoundError):
        await s.build_payment(CUSTOMER, nobody, "USDC", issuer, "1")  # issued asset needs an existing account
    with pytest.raises(TxRejectedError) as ei:
        await h.submit_xdr(sign(await h.build_payment(CUSTOMER, nobody, AssetRef("USDC", issuer), Decimal("1")), CUSTOMER_KP))
    assert ei.value.details["result_codes"]["operations"] == ["op_no_destination"]
    # native payment to a new account becomes create_account through the linked Soroban fake
    unsigned = await s.build_payment(CUSTOMER, nobody, "XLM", None, "3", memo="id-7", memo_type="text")
    assert unsigned.summary["operation"] == "create_account"
    await s.send(sign(unsigned, CUSTOMER_KP))
    assert (await h.get_account(nobody)).balance_of(AssetRef.native()).balance == Decimal("3")
    signers = await h.get_account_signers(CUSTOMER)
    assert signers is not None and signers.signers == [(CUSTOMER, 1)]
