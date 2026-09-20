"""Pure Stellar helpers shared by the Horizon/Soroban gateways and the fakes.

Everything here is side-effect free: XDR envelope / result parsing, asset conversion between the
SDK and our `AssetRef`, stroop <-> Decimal conversion and key generation. Only modules under
app/services/stellar import stellar_sdk; other slices use these wrappers.
"""
from __future__ import annotations

from decimal import ROUND_DOWN, Decimal

from stellar_sdk import Asset, Keypair, TransactionEnvelope
from stellar_sdk import xdr as stellar_xdr
from stellar_sdk.exceptions import (
    AssetCodeInvalidError,
    AssetIssuerInvalidError,
    Ed25519PublicKeyInvalidError,
    Ed25519SecretSeedInvalidError,
)
from stellar_sdk.memo import NoneMemo, TextMemo
from stellar_sdk.operation import Payment
from stellar_sdk.strkey import StrKey

from app.core.errors import StellarError
from app.services.stellar.types import AssetRef

STROOP = Decimal("0.0000001")
STROOPS_PER_UNIT = 10**7
MAX_TEXT_MEMO_BYTES = 28
#: Horizon/Stellar maximum trustline limit (int64 max in stroops).
MAX_TRUSTLINE_LIMIT = Decimal("922337203685.4775807")

# --- amounts -------------------------------------------------------------------------------


def stroops_to_decimal(stroops: int) -> Decimal:
    """int64 stroops -> Decimal with exactly 7 decimal places."""
    return (Decimal(int(stroops)) / Decimal(STROOPS_PER_UNIT)).quantize(STROOP)


def decimal_to_stroops(amount: Decimal | str | int) -> int:
    """Decimal amount -> int stroops (rounds DOWN, like quantize_amount)."""
    return int((Decimal(amount) * STROOPS_PER_UNIT).to_integral_value(rounding=ROUND_DOWN))


def amount_str(amount: Decimal | str | int) -> str:
    """Amount formatted the way the SDK / Horizon want it: plain decimal, <= 7 dp, no exponent."""
    return format(Decimal(amount).quantize(STROOP, rounding=ROUND_DOWN), "f")


# --- assets --------------------------------------------------------------------------------


def to_sdk_asset(ref: AssetRef) -> Asset:
    if ref.is_native:
        return Asset.native()
    try:
        return Asset(ref.code, ref.issuer)
    except (AssetCodeInvalidError, AssetIssuerInvalidError, ValueError) as e:
        raise StellarError(f"invalid asset {ref.canonical}: {e}", code="invalid_asset") from e


def from_sdk_asset(asset: Asset) -> AssetRef:
    if asset.is_native():
        return AssetRef.native()
    return AssetRef(asset.code, asset.issuer)


def asset_ref_from_horizon(record: dict, prefix: str = "asset") -> AssetRef:
    """Horizon encodes an asset as `<prefix>_type`, `<prefix>_code`, `<prefix>_issuer` keys.

    Works for balances / payments (`asset_*`), orderbook & offer sides (`asset_*` inside the side
    dict), strict-send path records (`source_asset_*`, `destination_asset_*`) and path hops.
    """
    asset_type = record.get(f"{prefix}_type")
    if asset_type in (None, "native"):
        return AssetRef.native()
    return AssetRef(str(record[f"{prefix}_code"]), str(record[f"{prefix}_issuer"]))


def dedupe_non_native(assets: list[AssetRef]) -> list[AssetRef]:
    """Non-native assets, order preserved, duplicates removed (for change_trust ops)."""
    seen: set[str] = set()
    out: list[AssetRef] = []
    for a in assets:
        if a.is_native or a.canonical in seen:
            continue
        seen.add(a.canonical)
        out.append(a)
    return out


# --- keys ----------------------------------------------------------------------------------


def random_keypair() -> tuple[str, str]:
    """(public_key, secret) of a freshly generated ed25519 keypair."""
    kp = Keypair.random()
    return kp.public_key, kp.secret


def public_key_from_secret(secret: str) -> str:
    try:
        return Keypair.from_secret(secret).public_key
    except (Ed25519SecretSeedInvalidError, ValueError, TypeError) as e:
        raise StellarError("invalid Stellar secret seed", code="invalid_secret") from e


def is_valid_public_key(public_key: object) -> bool:
    if not isinstance(public_key, str):
        return False
    try:
        return StrKey.is_valid_ed25519_public_key(public_key)
    except (Ed25519PublicKeyInvalidError, ValueError, TypeError):
        return False


# --- envelopes -----------------------------------------------------------------------------


def envelope_from_xdr(xdr: str, network_passphrase: str) -> TransactionEnvelope:
    """Decode a (v0/v1) transaction envelope. Fee-bump envelopes are rejected."""
    if not isinstance(xdr, str) or not xdr.strip():
        raise StellarError("empty transaction XDR", code="invalid_xdr")
    try:
        return TransactionEnvelope.from_xdr(xdr.strip(), network_passphrase)
    except Exception as e:  # SDK raises a zoo of ValueError subclasses here
        raise StellarError(f"cannot decode transaction envelope: {e}", code="invalid_xdr") from e


def memo_text_of(memo: object) -> str | None:
    """TextMemo -> str, NoneMemo -> None, anything else -> StellarError."""
    if memo is None or isinstance(memo, NoneMemo):
        return None
    if isinstance(memo, TextMemo):
        raw = memo.memo_text
        if isinstance(raw, str):
            return raw
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as e:
            raise StellarError("text memo is not valid UTF-8", code="invalid_memo") from e
    raise StellarError(f"unsupported memo type {type(memo).__name__}; a text memo is required", code="invalid_memo")


def check_text_memo(memo_text: str) -> str:
    if not isinstance(memo_text, str):
        raise StellarError("memo must be a string", code="invalid_memo")
    if len(memo_text.encode("utf-8")) > MAX_TEXT_MEMO_BYTES:
        raise StellarError(f"text memo exceeds {MAX_TEXT_MEMO_BYTES} bytes", code="invalid_memo")
    return memo_text


def parse_payment_envelope(xdr: str, network_passphrase: str) -> tuple[str, str, AssetRef, Decimal, str | None]:
    """Validate & decode an envelope that must contain exactly one `payment` operation.

    Returns (source_account, destination, asset, amount, memo_text). Muxed addresses are reduced to
    their underlying G... account id. Raises StellarError(code="invalid_payment_xdr"/"invalid_xdr"/
    "invalid_memo") on anything unexpected.
    """
    envelope = envelope_from_xdr(xdr, network_passphrase)
    tx = envelope.transaction
    ops = tx.operations
    if len(ops) != 1:
        raise StellarError(f"expected exactly one operation, got {len(ops)}", code="invalid_payment_xdr")
    op = ops[0]
    if not isinstance(op, Payment):
        raise StellarError(f"expected a payment operation, got {type(op).__name__}", code="invalid_payment_xdr")
    source = (op.source or tx.source).account_id
    destination = op.destination.account_id
    asset = from_sdk_asset(op.asset)
    try:
        amount = Decimal(str(op.amount))
    except Exception as e:  # pragma: no cover - SDK validates amounts on decode
        raise StellarError("payment amount is not a valid decimal", code="invalid_payment_xdr") from e
    memo = memo_text_of(tx.memo)
    return source, destination, asset, amount, memo


# --- transaction results -------------------------------------------------------------------


def transaction_result_from_xdr(result_xdr: str) -> stellar_xdr.TransactionResult:
    if not isinstance(result_xdr, str) or not result_xdr.strip():
        raise StellarError("empty transaction result XDR", code="invalid_result_xdr")
    try:
        return stellar_xdr.TransactionResult.from_xdr(result_xdr.strip())
    except Exception as e:
        raise StellarError(f"cannot decode transaction result: {e}", code="invalid_result_xdr") from e


def operation_results(result_xdr: str) -> list[stellar_xdr.OperationResult]:
    """Operation results of a TransactionResult (fee-bump results are unwrapped to the inner tx)."""
    result = transaction_result_from_xdr(result_xdr).result
    code = result.code
    fee_bump_codes = (
        stellar_xdr.TransactionResultCode.txFEE_BUMP_INNER_SUCCESS,
        stellar_xdr.TransactionResultCode.txFEE_BUMP_INNER_FAILED,
    )
    if code in fee_bump_codes:
        pair = result.inner_result_pair
        if pair is None:  # pragma: no cover - malformed XDR
            raise StellarError("fee bump result without inner result", code="invalid_result_xdr")
        inner = pair.result.result
        results = inner.results
        code = inner.code
    else:
        results = result.results
    if results is None:
        raise StellarError(f"transaction failed before operations ran: {code.name}", code="tx_failed",
                           details={"result_codes": {"transaction": _tx_code_name(code)}})
    return list(results)


def result_codes_from_xdr(result_xdr: str) -> dict[str, object]:
    """Horizon-style result codes ({"transaction": "tx_failed", "operations": [...]}) from a result XDR."""
    result = transaction_result_from_xdr(result_xdr).result
    tx_code = _tx_code_name(result.code)
    ops: list[str] = []
    for op in result.results or []:
        if op.code != stellar_xdr.OperationResultCode.opINNER or op.tr is None:
            ops.append(_op_code_name(op.code))
            continue
        ops.append(_inner_op_code_name(op.tr))
    out: dict[str, object] = {"transaction": tx_code}
    if ops:
        out["operations"] = ops
    return out


def _tx_code_name(code: stellar_xdr.TransactionResultCode) -> str:
    # txSUCCESS -> tx_success, txBAD_SEQ -> tx_bad_seq
    return "tx_" + code.name[2:].lower()


def _op_code_name(code: stellar_xdr.OperationResultCode) -> str:
    return "op_" + code.name[2:].lower()


def _inner_op_code_name(tr: stellar_xdr.OperationResultTr) -> str:
    inner = _inner_result(tr)
    inner_code = getattr(inner, "code", None)
    if inner_code is None:
        return "op_unknown"
    name = inner_code.name  # e.g. PATH_PAYMENT_STRICT_SEND_UNDERFUNDED / PAYMENT_SUCCESS
    if name.endswith("_SUCCESS"):
        return "op_success"
    prefix = tr.type.name + "_"
    if name.startswith(prefix):
        name = name[len(prefix):]
    return "op_" + name.lower()


def _inner_result(tr: stellar_xdr.OperationResultTr) -> object | None:
    attr = tr.type.name.lower() + "_result"
    return getattr(tr, attr, None)


def _op_result_tr(result_xdr: str, op_index: int) -> stellar_xdr.OperationResultTr:
    results = operation_results(result_xdr)
    if op_index < 0 or op_index >= len(results):
        raise StellarError(f"operation index {op_index} out of range ({len(results)} results)", code="invalid_result_xdr")
    op = results[op_index]
    if op.code != stellar_xdr.OperationResultCode.opINNER or op.tr is None:
        raise StellarError(f"operation {op_index} failed: {_op_code_name(op.code)}", code="op_failed",
                           details={"result_codes": result_codes_from_xdr(result_xdr)})
    return op.tr


def received_amount_from_result(result_xdr: str, op_index: int = 0) -> Decimal:
    """Destination amount actually delivered by a path payment op (`success.last.amount`)."""
    tr = _op_result_tr(result_xdr, op_index)
    if tr.type == stellar_xdr.OperationType.PATH_PAYMENT_STRICT_SEND:
        res = tr.path_payment_strict_send_result
    elif tr.type == stellar_xdr.OperationType.PATH_PAYMENT_STRICT_RECEIVE:
        res = tr.path_payment_strict_receive_result
    else:
        raise StellarError(f"operation {op_index} is {tr.type.name}, not a path payment", code="invalid_result_xdr")
    if res is None or res.success is None:
        code = res.code.name.lower() if res is not None else "missing"
        raise StellarError(f"path payment {op_index} failed: {code}", code="op_failed",
                           details={"result_codes": result_codes_from_xdr(result_xdr)})
    return stroops_to_decimal(res.success.last.amount.int64)


def offer_id_from_result(result_xdr: str, op_index: int = 0) -> int | None:
    """Offer id created/updated by a manage offer op; None when it was fully consumed or deleted."""
    tr = _op_result_tr(result_xdr, op_index)
    if tr.type == stellar_xdr.OperationType.MANAGE_SELL_OFFER:
        res = tr.manage_sell_offer_result
    elif tr.type == stellar_xdr.OperationType.MANAGE_BUY_OFFER:
        res = tr.manage_buy_offer_result
    elif tr.type == stellar_xdr.OperationType.CREATE_PASSIVE_SELL_OFFER:
        res = tr.create_passive_sell_offer_result
    else:
        raise StellarError(f"operation {op_index} is {tr.type.name}, not a manage offer", code="invalid_result_xdr")
    if res is None or res.success is None:
        code = res.code.name.lower() if res is not None else "missing"
        raise StellarError(f"manage offer {op_index} failed: {code}", code="op_failed",
                           details={"result_codes": result_codes_from_xdr(result_xdr)})
    offer = res.success.offer
    if offer.effect == stellar_xdr.ManageOfferEffect.MANAGE_OFFER_DELETED or offer.offer is None:
        return None
    return int(offer.offer.offer_id.int64)


# --- envelope helpers (added for the Soroban/tx-submit flow) --------------------------------


def envelope_hash_hex(xdr: str, network_passphrase: str) -> str:
    """Transaction hash (hex) of an envelope; signatures do not change it."""
    return envelope_from_xdr(xdr, network_passphrase).hash_hex()


def envelope_source(xdr: str, network_passphrase: str) -> str:
    """G... source account of an envelope (muxed reduced to the underlying account)."""
    return envelope_from_xdr(xdr, network_passphrase).transaction.source.account_id


def apply_memo(builder: object, memo: str | int | None, memo_type: str | None) -> None:
    """Attach a memo to a TransactionBuilder. memo_type: none|text|id|hash (SEP-24 withdraw memos).

    Hash memos are accepted as base64 (SEP-24) or 64-char hex."""
    if memo is None or memo == "" or (memo_type or "").lower() in ("", "none"):
        if memo not in (None, "") and memo_type in (None, ""):
            memo_type = "text"
        else:
            return
    kind = (memo_type or "text").lower()
    if kind == "text":
        builder.add_text_memo(check_text_memo(str(memo)))  # type: ignore[attr-defined]
    elif kind == "id":
        try:
            builder.add_id_memo(int(memo))  # type: ignore[attr-defined]
        except (TypeError, ValueError) as e:
            raise StellarError("id memo must be an unsigned 64-bit integer", code="invalid_memo") from e
    elif kind == "hash":
        raw = _decode_hash_memo(str(memo))
        builder.add_hash_memo(raw)  # type: ignore[attr-defined]
    else:
        raise StellarError(f"unsupported memo type {memo_type}", code="invalid_memo")


def _decode_hash_memo(value: str) -> bytes:
    import base64
    import binascii

    v = value.strip()
    if len(v) == 64:
        try:
            return bytes.fromhex(v)
        except ValueError:
            pass
    try:
        raw = base64.b64decode(v + "=" * (-len(v) % 4))
    except (binascii.Error, ValueError) as e:
        raise StellarError("hash memo must be base64 or hex", code="invalid_memo") from e
    if len(raw) != 32:
        raise StellarError("hash memo must decode to 32 bytes", code="invalid_memo")
    return raw
