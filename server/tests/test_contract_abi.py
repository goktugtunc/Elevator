"""contract_abi: SCVal round-trips for Terms/Agreement/Config/TokenInfo, event decoding from hand-built
SCVals (the exact shapes soroban-sdk 28 `#[contractevent]` publishes) and error-code parsing."""
from __future__ import annotations

import pytest
from stellar_sdk import Keypair, scval
from stellar_sdk import xdr as sx
from stellar_sdk.strkey import StrKey

from app.core.errors import StellarError
from app.services.stellar import contract_abi as abi
from app.services.stellar.contract_abi import (
    ActivatedEvent,
    Agreement,
    CancelledEvent,
    Config,
    ConfigChangedEvent,
    OpenedEvent,
    ProposedEvent,
    SettledEvent,
    Status,
    Terms,
    TokenInfo,
    TokenSetEvent,
    TradedEvent,
    UpgradedEvent,
    VaultContractError,
    VaultError,
    decode_event,
)

CUSTOMER = Keypair.from_raw_ed25519_seed(bytes([1]) * 32).public_key
TRADER = Keypair.from_raw_ed25519_seed(bytes([2]) * 32).public_key
XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
USDC = "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F"
ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"


def _terms(**kw) -> Terms:
    base = dict(
        customer=CUSTOMER,
        trader=TRADER,
        base_token=XLM,
        principal=1_000_0000000,
        duration_secs=30 * 86_400,
        commission_bps=2000,
        max_drawdown_bps=1500,
        listing_ref=bytes(range(32)),
    )
    base.update(kw)
    return Terms(**base)


def _map_keys(v: sx.SCVal) -> list[str]:
    return [scval.from_symbol(k) for k in scval.from_map(v)]


# --- structs ---------------------------------------------------------------------------------


def test_terms_roundtrip_and_shape():
    t = _terms()
    v = t.to_scval()
    assert v.type == sx.SCValType.SCV_MAP
    # map keys are symbols sorted by name (CAP-46 validity rule the host enforces)
    assert _map_keys(v) == sorted(
        ["customer", "trader", "base_token", "principal", "duration_secs", "commission_bps", "max_drawdown_bps", "listing_ref"]
    )
    fields = scval.from_struct(v)
    assert fields["principal"].type == sx.SCValType.SCV_I128
    assert fields["duration_secs"].type == sx.SCValType.SCV_U64
    assert fields["commission_bps"].type == sx.SCValType.SCV_U32
    assert fields["listing_ref"].type == sx.SCValType.SCV_BYTES
    assert fields["customer"].type == sx.SCValType.SCV_ADDRESS
    assert Terms.from_scval(v) == t
    assert Terms.from_scval(v.to_xdr()) == t  # base64 form accepted too
    assert t.as_dict()["listing_ref"] == bytes(range(32)).hex()


def test_terms_validate_mirrors_contract_ranges():
    _terms().validate()
    for bad in (
        dict(principal=0),
        dict(duration_secs=abi.MIN_DURATION - 1),
        dict(duration_secs=abi.MAX_DURATION + 1),
        dict(commission_bps=abi.MAX_COMMISSION_BPS + 1),
        dict(max_drawdown_bps=abi.MIN_DRAWDOWN_BPS - 1),
        dict(max_drawdown_bps=10_001),
        dict(trader=CUSTOMER),
        dict(listing_ref=b"\x00" * 31),
    ):
        with pytest.raises(VaultContractError) as ei:
            _terms(**bad).validate()
        assert ei.value.error is VaultError.InvalidTerms
        assert ei.value.status_code == 409
        assert ei.value.details["contract_error_code"] == 4


def test_status_is_u32_enum():
    v = Status.Active.to_scval()
    assert v.type == sx.SCValType.SCV_U32 and scval.from_uint32(v) == 2
    assert Status.from_scval(scval.to_uint32(3)) is Status.Settled
    # tolerate a unit-variant symbol encoding of the same names
    assert Status.from_scval(scval.to_enum("Cancelled", None)) is Status.Cancelled
    assert Status.from_scval(scval.to_symbol("Funded")) is Status.Funded
    with pytest.raises(StellarError):
        Status.from_scval(scval.to_int128(1))
    assert Status.Proposed.label == "proposed"


def test_agreement_roundtrip():
    ag = Agreement(
        id=7,
        terms=_terms(),
        status=Status.Active,
        proposer=CUSTOMER,
        created_at=1_800_000_000,
        start_time=1_800_000_100,
        end_time=1_800_000_100 + 30 * 86_400,
        tokens=[XLM, USDC],
        settled_at=0,
        final_value=0,
        trader_fee=0,
        platform_fee=0,
        customer_payout=0,
    )
    v = ag.to_scval()
    assert _map_keys(v) == sorted(
        [
            "id", "terms", "status", "proposer", "created_at", "start_time", "end_time", "tokens",
            "settled_at", "final_value", "trader_fee", "platform_fee", "customer_payout",
        ]
    )
    back = Agreement.from_scval(v)
    assert back == ag
    assert back.is_active and back.is_open
    d = back.as_dict()
    assert d["status"] == "active" and d["terms"]["customer"] == CUSTOMER and d["tokens"] == [XLM, USDC]


def test_agreement_missing_field_is_decode_error():
    v = _terms().to_scval()  # a Terms map is not an Agreement
    with pytest.raises(StellarError) as ei:
        Agreement.from_scval(v)
    assert ei.value.code == "abi_decode_error"


def test_config_tokeninfo_balances_roundtrip():
    cfg = Config(admin=CUSTOMER, router=ROUTER, platform_fee_bps=50, fee_recipient=TRADER, paused=True, settle_slippage_bps=100)
    assert Config.from_scval(cfg.to_scval()) == cfg
    ti = TokenInfo(allowed=True, is_base=False)
    assert TokenInfo.from_scval(ti.to_scval()) == ti
    bal = [(XLM, 10_0000000), (USDC, 3_1234567)]
    v = abi.encode_balances(bal)
    assert v.type == sx.SCValType.SCV_VEC
    assert abi.decode_balances(v) == bal
    assert abi.decode_balances(v.to_xdr()) == bal
    assert abi.decode_i128(scval.to_int128(-5)) == -5
    assert abi.decode_u64(scval.to_uint64(9)) == 9
    assert abi.decode_i128_vec(scval.to_vec([scval.to_int128(1), scval.to_int128(2)])) == [1, 2]


def test_function_arg_encoders():
    args = abi.args_trade(3, XLM, USDC, 100, 90, 1_800_000_500)
    assert [a.type for a in args] == [
        sx.SCValType.SCV_U64, sx.SCValType.SCV_ADDRESS, sx.SCValType.SCV_ADDRESS,
        sx.SCValType.SCV_I128, sx.SCValType.SCV_I128, sx.SCValType.SCV_U64,
    ]
    settle = abi.args_settle(3, CUSTOMER, [1, 2])
    assert abi.decode_i128_vec(settle[2]) == [1, 2]
    cancel = abi.args_cancel(3, TRADER)
    assert abi.dec_u64(cancel[0]) == 3 and abi.dec_address(cancel[1]) == TRADER
    open_args = abi.args_open(CUSTOMER, _terms())
    assert Terms.from_scval(open_args[1]) == _terms()
    router_args = abi.args_router_amounts_out(5, [XLM, USDC])
    assert abi.dec_address_vec(router_args[1]) == [XLM, USDC]


# --- events ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "event",
    [
        ProposedEvent(id=1, trader=TRADER, customer=CUSTOMER, principal=5_0000000, base_token=XLM),
        OpenedEvent(id=2, trader=TRADER, customer=CUSTOMER, principal=5_0000000, base_token=USDC),
        ActivatedEvent(id=2, start_time=1_800_000_000, end_time=1_800_086_400),
        CancelledEvent(id=3, refunded=5_0000000),
        TradedEvent(id=2, trader=TRADER, token_in=XLM, token_out=USDC, amount_in=10_0000000, amount_out=2_8983090, value_after=99_0000000),
        SettledEvent(id=2, final_value=120, profit=20, trader_fee=4, platform_fee=0, customer_payout=116, by=CUSTOMER),
        ConfigChangedEvent(key="fees", router=ROUTER, platform_fee_bps=25, fee_recipient=TRADER, paused=False, settle_slippage_bps=100),
        TokenSetEvent(token=USDC, allowed=True, is_base=True),
        UpgradedEvent(wasm_hash=bytes([9]) * 32),
    ],
)
def test_event_roundtrip(event):
    topics, data = event.to_scvals()
    assert scval.from_symbol(topics[0]) == event.NAME
    assert len(topics) == 1 + len(event.TOPIC_FIELDS)
    if event.DATA_FIELDS:
        assert _map_keys(data) == sorted(event.DATA_FIELDS)  # sdk sorts data map keys
    assert decode_event(topics, data) == event
    topics_b64, data_b64 = event.to_xdr()
    assert decode_event(topics_b64, data_b64) == event
    assert decode_event(topics_b64, data_b64).as_dict()["event"] == event.NAME


def test_decode_hand_built_traded_event():
    """Shape straight from soroban-sdk: topics [sym("traded"), u64 id, Address trader], data = sorted map."""
    topics = [scval.to_symbol("traded"), scval.to_uint64(42), scval.to_address(TRADER)]
    data = scval.to_map(
        {
            scval.to_symbol("amount_in"): scval.to_int128(10_0000000),
            scval.to_symbol("amount_out"): scval.to_int128(2_8983090),
            scval.to_symbol("token_in"): scval.to_address(XLM),
            scval.to_symbol("token_out"): scval.to_address(USDC),
            scval.to_symbol("value_after"): scval.to_int128(99_0000000),
        }
    )
    ev = decode_event(topics, data)
    assert isinstance(ev, TradedEvent)
    assert ev.id == 42 and ev.trader == TRADER and ev.token_in == XLM and ev.token_out == USDC
    assert ev.amount_in == 10_0000000 and ev.amount_out == 2_8983090 and ev.value_after == 99_0000000


def test_decode_hand_built_settled_and_activated():
    settled = decode_event(
        [scval.to_symbol("settled"), scval.to_uint64(5)],
        scval.to_map(
            {
                scval.to_symbol("by"): scval.to_address(CUSTOMER),
                scval.to_symbol("customer_payout"): scval.to_int128(116),
                scval.to_symbol("final_value"): scval.to_int128(120),
                scval.to_symbol("platform_fee"): scval.to_int128(0),
                scval.to_symbol("profit"): scval.to_int128(20),
                scval.to_symbol("trader_fee"): scval.to_int128(4),
            }
        ),
    )
    assert settled == SettledEvent(id=5, final_value=120, profit=20, trader_fee=4, platform_fee=0, customer_payout=116, by=CUSTOMER)
    activated = decode_event(
        [scval.to_symbol("activated").to_xdr(), scval.to_uint64(5).to_xdr()],
        scval.to_map({scval.to_symbol("end_time"): scval.to_uint64(20), scval.to_symbol("start_time"): scval.to_uint64(10)}).to_xdr(),
    )
    assert activated == ActivatedEvent(id=5, start_time=10, end_time=20)


def test_decode_event_unknown_or_malformed():
    # SAC `transfer` event: not ours -> None
    sac_topics = [scval.to_symbol("transfer"), scval.to_address(CUSTOMER), scval.to_address(TRADER), scval.to_string("native")]
    assert decode_event(sac_topics, scval.to_int128(1)) is None
    assert decode_event([scval.to_uint32(1)], scval.to_void()) is None
    assert decode_event([], None) is None
    # right name, wrong topic count -> decode error
    with pytest.raises(StellarError) as ei:
        decode_event([scval.to_symbol("traded"), scval.to_uint64(1)], scval.to_void())
    assert ei.value.code == "abi_decode_error"
    # right name, missing data field
    with pytest.raises(StellarError):
        decode_event([scval.to_symbol("cancelled"), scval.to_uint64(1)], scval.to_map({}))


def test_event_topic_filters():
    filters = abi.event_topic_filters(["traded", "settled"])
    assert filters == [[scval.to_symbol("traded").to_xdr(), "*", "*"], [scval.to_symbol("settled").to_xdr(), "*"]]
    assert len(abi.event_topic_filters()) == len(abi.EVENT_TYPES)
    assert abi.AGREEMENT_EVENT_NAMES <= set(abi.EVENT_TYPES)


# --- errors ----------------------------------------------------------------------------------


def test_error_codes_mirror_rust():
    assert [e.value for e in VaultError] == list(range(1, 18))
    assert VaultError(12) is VaultError.DrawdownBreached and VaultError(17) is VaultError.NotParty
    assert VaultError.from_code(99) is None and VaultError.from_code(None) is None


def test_parse_contract_error_from_simulation_text():
    text = (
        "HostError: Error(Contract, #12)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:..., "
        'topics:[error, Error(Contract, #12)], data:["escalating error to VM trap from failed host function call", ...]'
    )
    assert abi.parse_contract_error(text) == 12
    assert abi.parse_contract_error("HostError: Error(Auth, InvalidAction)") is None
    assert abi.parse_contract_error(None) is None
    err = VaultContractError(12, context="trade")
    assert err.error is VaultError.DrawdownBreached and err.code == "contract_error" and "DrawdownBreached" in err.message
    unknown = VaultContractError(99)
    assert unknown.error is None and unknown.details["contract_error"] == "Unknown(99)"


def test_contract_error_from_scval():
    v = sx.SCVal(sx.SCValType.SCV_ERROR, error=sx.SCError(sx.SCErrorType.SCE_CONTRACT, contract_code=sx.Uint32(7)))
    assert abi.contract_error_from_scval(v) == 7
    auth = sx.SCVal(sx.SCValType.SCV_ERROR, error=sx.SCError(sx.SCErrorType.SCE_AUTH, code=sx.SCErrorCode.SCEC_INVALID_ACTION))
    assert abi.contract_error_from_scval(auth) is None
    assert abi.contract_error_from_scval(scval.to_uint32(7)) is None


def test_listing_ref_helpers():
    raw = abi.listing_ref_from_hex("ab" * 32)
    assert raw == bytes([0xAB]) * 32
    with pytest.raises(StellarError):
        abi.listing_ref_from_hex("ab" * 31)
    assert StrKey.is_valid_contract(XLM)
