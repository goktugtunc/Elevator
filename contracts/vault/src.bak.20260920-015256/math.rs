//! Pure, checked arithmetic for valuation and settlement (DESIGN.md §1.3/§1.4).
//! Floor rounding everywhere; fees are computed on profit only so they can
//! never exceed it.

use crate::errors::Error;
use crate::types::BPS_DENOM;

/// `amount * bps / 10_000`, floor. `amount` must be >= 0.
pub fn bps_of(amount: i128, bps: u32) -> Result<i128, Error> {
    if amount < 0 {
        return Err(Error::InvalidAmount);
    }
    amount
        .checked_mul(bps as i128)
        .ok_or(Error::Overflow)?
        .checked_div(BPS_DENOM)
        .ok_or(Error::Overflow)
}

/// Minimum portfolio value the agreement may have after a trade:
/// `principal * (10_000 - max_drawdown_bps) / 10_000`.
pub fn drawdown_floor(principal: i128, max_drawdown_bps: u32) -> Result<i128, Error> {
    let keep_bps = (BPS_DENOM as u32)
        .checked_sub(max_drawdown_bps)
        .ok_or(Error::InvalidTerms)?;
    bps_of(principal, keep_bps)
}

/// `quote * (10_000 - slippage_bps) / 10_000`, used on the permissionless
/// settlement path.
pub fn min_out_with_slippage(quote: i128, slippage_bps: u32) -> Result<i128, Error> {
    let keep_bps = (BPS_DENOM as u32)
        .checked_sub(slippage_bps)
        .ok_or(Error::InvalidTerms)?;
    bps_of(quote, keep_bps)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub profit: i128,
    pub trader_fee: i128,
    pub platform_fee: i128,
    pub customer_payout: i128,
}

/// Settlement split. Invariants (property-tested):
/// `customer_payout + trader_fee + platform_fee == final_value`,
/// `trader_fee + platform_fee <= profit`, all components >= 0 when
/// `final_value >= 0` and `commission_bps + platform_fee_bps <= 10_000`.
pub fn settlement(
    final_value: i128,
    principal: i128,
    commission_bps: u32,
    platform_fee_bps: u32,
) -> Result<Settlement, Error> {
    if final_value < 0 || principal < 0 {
        return Err(Error::InvalidAmount);
    }
    let profit = final_value.checked_sub(principal).ok_or(Error::Overflow)?;
    let profit = if profit > 0 { profit } else { 0 };
    let trader_fee = bps_of(profit, commission_bps)?;
    let platform_fee = bps_of(profit, platform_fee_bps)?;
    let customer_payout = final_value
        .checked_sub(trader_fee)
        .ok_or(Error::Overflow)?
        .checked_sub(platform_fee)
        .ok_or(Error::Overflow)?;
    if customer_payout < 0 {
        // Only reachable if commission_bps + platform_fee_bps > 10_000,
        // which validation prevents; keep the guard for defence in depth.
        return Err(Error::Overflow);
    }
    Ok(Settlement {
        profit,
        trader_fee,
        platform_fee,
        customer_payout,
    })
}
