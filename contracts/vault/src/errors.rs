//! Typed contract errors. The numeric codes are part of the public ABI and
//! are mirrored by the backend (`app/services/contract_abi.py`) and the mobile
//! app. Never renumber or reuse a code; only append.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Config missing from instance storage (cannot happen after a
    /// successful constructor; kept for defensive reads).
    NotInitialized = 1,
    /// A free `Address` argument does not match the party it claims to be
    /// (e.g. `propose(trader, terms)` with `trader != terms.trader`).
    Unauthorized = 2,
    /// Contract is paused; `propose/open/fund/accept/trade` are blocked.
    Paused = 3,
    /// Terms or admin parameters outside the allowed ranges.
    InvalidTerms = 4,
    /// Token is not allow-listed (or not allow-listed as a base token).
    TokenNotAllowed = 5,
    /// No agreement with this id.
    NotFound = 6,
    /// Agreement is not in the status the call requires.
    WrongStatus = 7,
    /// `now >= end_time` (trade) or the trade deadline is in the past.
    Expired = 8,
    /// A non-party tried to settle before `end_time`.
    NotExpired = 9,
    /// `amount_in` exceeds the agreement's balance of `token_in`.
    InsufficientBalance = 10,
    /// Agreement already holds `MAX_TOKENS` distinct tokens.
    TooManyTokens = 11,
    /// Portfolio value after the trade would fall below the drawdown floor.
    DrawdownBreached = 12,
    /// Router returned / delivered less than `min_out`.
    SlippageExceeded = 13,
    /// Checked arithmetic overflow.
    Overflow = 14,
    /// Amount <= 0, or a malformed `min_outs` vector.
    InvalidAmount = 15,
    /// The router call (pair lookup / swap) failed.
    RouterError = 16,
    /// Caller is not one of the addresses allowed to perform this action.
    NotParty = 17,
    /// No reservation with this id.
    ReservationNotFound = 18,
    /// Reservation is no longer Open (fully released or fully consumed).
    ReservationClosed = 19,
    /// Reservation does not hold enough to cover the amount requested.
    ReservationInsufficient = 20,
    /// Reservation belongs to another customer, or holds another token than
    /// the agreement's base token.
    ReservationMismatch = 21,
}
