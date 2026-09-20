"""Money helpers: Decimal (7 dp) in the API/DB  <->  i128 raw units ("stroops") on-chain.

Rules (ARCHITECTURE §3): never float; quantize ROUND_DOWN; conversion to/from on-chain integers happens
here and nowhere else. `settle_math` mirrors the contract's §1.4 formula in integer arithmetic so the
backend can pre-compute/verify payouts (property-tested against the contract semantics).
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal, InvalidOperation

DEFAULT_DECIMALS = 7
STROOP = Decimal(1).scaleb(-DEFAULT_DECIMALS)  # Decimal("0.0000001")
BPS_DENOM = 10_000
I128_MAX = 2**127 - 1
I128_MIN = -(2**127)
ZERO = Decimal("0")


def _unit(decimals: int) -> Decimal:
    return Decimal(1).scaleb(-decimals)


def quantize(amount: Decimal | int | str, decimals: int = DEFAULT_DECIMALS) -> Decimal:
    """Round DOWN to `decimals` places (the only rounding mode money may use here)."""
    try:
        return Decimal(amount).quantize(_unit(decimals), rounding=ROUND_DOWN)
    except InvalidOperation as e:  # NaN / Infinity / garbage
        raise ValueError(f"not a valid amount: {amount!r}") from e


def to_stroops(amount: Decimal | int | str, decimals: int = DEFAULT_DECIMALS) -> int:
    """Decimal token amount -> raw integer units (i128). Strict: raises ValueError when `amount` has
    more precision than the token allows (quantize first if truncation is intended) or would not fit
    into an i128."""
    try:
        d = Decimal(amount)
    except InvalidOperation as e:
        raise ValueError(f"not a valid amount: {amount!r}") from e
    if not d.is_finite():
        raise ValueError(f"not a finite amount: {amount!r}")
    scaled = d.scaleb(decimals)
    if scaled != scaled.to_integral_value():
        raise ValueError(f"{d} has more than {decimals} decimal places")
    raw = int(scaled)
    if raw > I128_MAX or raw < I128_MIN:
        raise ValueError(f"{d} does not fit into i128 with {decimals} decimals")
    return raw


def from_stroops(raw: int, decimals: int = DEFAULT_DECIMALS) -> Decimal:
    """Raw integer units (i128) -> Decimal token amount with exactly `decimals` places."""
    return (Decimal(int(raw)) * _unit(decimals)).quantize(_unit(decimals), rounding=ROUND_DOWN)


def format_amount(amount: Decimal, decimals: int = DEFAULT_DECIMALS) -> str:
    """Fixed-point string for the API ("12.5000000"), never scientific notation."""
    return format(quantize(amount, decimals), "f")


def bps_floor(raw: int, bps: int) -> int:
    """`raw × bps / 10000` with floor rounding, as the contract does (integer domain)."""
    if bps < 0 or bps > BPS_DENOM:
        raise ValueError(f"bps out of range: {bps}")
    return (int(raw) * int(bps)) // BPS_DENOM


def apply_bps(amount: Decimal, bps: int, decimals: int = DEFAULT_DECIMALS) -> Decimal:
    """Decimal variant of `bps_floor` (result quantized ROUND_DOWN)."""
    return from_stroops(bps_floor(to_stroops(quantize(amount, decimals), decimals), bps), decimals)


def min_out_for_slippage(quoted_out: int, slippage_bps: int) -> int:
    """`quote × (1 − slippage)` floor — the `min_out` handed to `trade` / `settle`."""
    if slippage_bps < 0 or slippage_bps > BPS_DENOM:
        raise ValueError(f"slippage_bps out of range: {slippage_bps}")
    return (int(quoted_out) * (BPS_DENOM - int(slippage_bps))) // BPS_DENOM


def drawdown_floor(principal: int, max_drawdown_bps: int) -> int:
    """Portfolio value below which the contract rejects a trade: `principal × (10000 − dd) / 10000`."""
    if max_drawdown_bps < 0 or max_drawdown_bps > BPS_DENOM:
        raise ValueError(f"max_drawdown_bps out of range: {max_drawdown_bps}")
    return (int(principal) * (BPS_DENOM - int(max_drawdown_bps))) // BPS_DENOM


@dataclass(frozen=True)
class Settlement:
    """All values in raw integer units (i128)."""

    final_value: int
    profit: int
    trader_fee: int
    platform_fee: int
    customer_payout: int


def settle_math(final_value: int, principal: int, commission_bps: int, platform_fee_bps: int) -> Settlement:
    """DESIGN §1.4 — checked i128 arithmetic, floor rounding, fees never exceed profit:

        profit          = max(0, final_value − principal)
        trader_fee      = profit × commission_bps / 10000
        platform_fee    = profit × platform_fee_bps / 10000
        customer_payout = final_value − trader_fee − platform_fee
    """
    if final_value < 0 or principal < 0:
        raise ValueError("amounts must be non-negative")
    profit = max(0, int(final_value) - int(principal))
    trader_fee = bps_floor(profit, commission_bps)
    platform_fee = bps_floor(profit, platform_fee_bps)
    customer_payout = int(final_value) - trader_fee - platform_fee
    for v in (final_value, profit, trader_fee, platform_fee, customer_payout):
        if v > I128_MAX or v < I128_MIN:
            raise OverflowError("i128 overflow in settlement math")
    return Settlement(int(final_value), profit, trader_fee, platform_fee, customer_payout)


__all__ = [
    "BPS_DENOM",
    "DEFAULT_DECIMALS",
    "I128_MAX",
    "I128_MIN",
    "STROOP",
    "ZERO",
    "Settlement",
    "apply_bps",
    "bps_floor",
    "drawdown_floor",
    "format_amount",
    "from_stroops",
    "min_out_for_slippage",
    "quantize",
    "settle_math",
    "to_stroops",
]
