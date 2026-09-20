//! On-chain data types and constants (DESIGN.md §1.1).

use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Maximum number of distinct tokens an agreement may hold (base included).
pub const MAX_TOKENS: u32 = 6;
/// Minimum agreement duration: 1 day.
pub const MIN_DURATION: u64 = 86_400;
/// Maximum agreement duration: 3 years.
pub const MAX_DURATION: u64 = 3 * 365 * 86_400;
/// Trader commission cap (50% of profit).
pub const MAX_COMMISSION_BPS: u32 = 5_000;
/// Platform fee cap (10% of profit).
pub const MAX_PLATFORM_FEE_BPS: u32 = 1_000;
/// Smallest allowed max-drawdown (1%). 10_000 disables the check.
pub const MIN_DRAWDOWN_BPS: u32 = 100;
/// Cap for the in-contract settlement slippage used on the keeper
/// (non-party) settlement path (50%).
pub const MAX_SETTLE_SLIPPAGE_BPS: u32 = 5_000;
/// Head start the parties and the admin get after `end_time` before the
/// permissionless keeper path of `settle` opens (7 days).
pub const SETTLE_GRACE_SECS: u64 = 7 * 86_400;
/// Basis-point denominator.
pub const BPS_DENOM: i128 = 10_000;

/// Ledgers per day (~5s ledgers).
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// Extend when fewer than 30 days of TTL remain ...
pub const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
/// ... to 120 days.
pub const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Status {
    /// Created by the trader, no funds yet. `fund` by the customer -> Active.
    Proposed = 0,
    /// Created and funded by the customer. `accept` by the trader -> Active.
    Funded = 1,
    /// Principal escrowed, trader may trade until `end_time`.
    Active = 2,
    /// Liquidated and paid out.
    Settled = 3,
    /// Cancelled before activation (principal refunded if it was escrowed).
    Cancelled = 4,
}

/// Lifecycle of a capital reservation (DESIGN.md §1.1).
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ReservationStatus {
    /// Funds held by the contract; may back an agreement or be released.
    Open = 0,
    /// Every unit was handed back to the customer.
    Released = 1,
    /// Every unit was drawn into agreements.
    Consumed = 2,
}

/// Capital a customer locks up front so a listing is backed by real funds.
/// The money sits in the contract from `reserve` until it is either drawn
/// into an agreement (`open_reserved` / `fund_reserved`) or handed back
/// (`release`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reservation {
    pub id: u64,
    pub customer: Address,
    /// Base token held; must be allow-listed as a base token at `reserve`.
    pub token: Address,
    /// Amount **still** held (raw units). Shrinks as agreements draw on it.
    pub amount: i128,
    /// Amount originally locked; kept so the app can show progress.
    pub original: i128,
    pub status: ReservationStatus,
    pub created_at: u64,
    /// sha256 of the off-chain listing id (indexing only).
    pub listing_ref: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Terms {
    pub customer: Address,
    pub trader: Address,
    pub base_token: Address,
    /// Amount of `base_token` escrowed (raw units, 7 dp for SAC tokens).
    pub principal: i128,
    /// Agreement duration in seconds (sure).
    pub duration_secs: u64,
    /// Trader's share of positive profit, 0..=5000 bps.
    pub commission_bps: u32,
    /// Max drawdown enforced at trade time, 100..=10000 bps (10000 = off).
    pub max_drawdown_bps: u32,
    /// sha256 of the off-chain listing/offer id (indexing only).
    pub listing_ref: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Agreement {
    pub id: u64,
    pub terms: Terms,
    pub status: Status,
    /// Who created the agreement (customer via `open`, trader via `propose`).
    pub proposer: Address,
    pub created_at: u64,
    /// 0 until Active.
    pub start_time: u64,
    /// 0 until Active.
    pub end_time: u64,
    /// Tokens currently held; `base_token` is always first. len <= MAX_TOKENS.
    /// After settlement: the base slot plus any in-kind leg still claimable.
    pub tokens: Vec<Address>,
    pub settled_at: u64,
    pub final_value: i128,
    pub trader_fee: i128,
    pub platform_fee: i128,
    pub customer_payout: i128,
    /// Portfolio value (base units) recorded by the contract itself: the
    /// principal at creation, then `value_after` of every trade. Reference
    /// for the permissionless settlement floor; a value from a previous
    /// ledger cannot be moved inside the settling transaction.
    pub last_value: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub router: Address,
    pub platform_fee_bps: u32,
    pub fee_recipient: Address,
    pub paused: bool,
    pub settle_slippage_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenInfo {
    pub allowed: bool,
    pub is_base: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// instance: Config
    Config,
    /// instance: u64 (next agreement id, starts at 1)
    NextId,
    /// persistent: Agreement
    Agreement(u64),
    /// persistent: i128 (agreement id, token) -> balance held for it
    Balance(u64, Address),
    /// instance: TokenInfo
    AllowedToken(Address),
    /// persistent: Reservation
    Reservation(u64),
    /// instance: u64 (next reservation id, starts at 1)
    NextReservationId,
}
