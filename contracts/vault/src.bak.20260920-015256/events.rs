//! Contract events (DESIGN.md §1.2). Topic layout: event name (snake_case)
//! followed by the `#[topic]` fields in order; remaining fields form the
//! data map. Indexers filter on topics.

use soroban_sdk::{contractevent, Address, BytesN, Symbol};

/// Trader created an agreement (no funds yet).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposed {
    #[topic]
    pub id: u64,
    #[topic]
    pub trader: Address,
    #[topic]
    pub customer: Address,
    pub principal: i128,
    pub base_token: Address,
}

/// Customer created and funded an agreement.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Opened {
    #[topic]
    pub id: u64,
    #[topic]
    pub trader: Address,
    #[topic]
    pub customer: Address,
    pub principal: i128,
    pub base_token: Address,
}

/// Agreement became Active (after `fund` or `accept`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Activated {
    #[topic]
    pub id: u64,
    pub start_time: u64,
    pub end_time: u64,
}

/// Agreement cancelled before activation. `refunded` is the principal sent
/// back to the customer (0 for a Proposed agreement).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cancelled {
    #[topic]
    pub id: u64,
    pub refunded: i128,
}

/// A swap executed by the trader.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Traded {
    #[topic]
    pub id: u64,
    #[topic]
    pub trader: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    /// Portfolio value in base token after the trade (router quotes).
    pub value_after: i128,
}

/// Agreement liquidated and paid out.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub id: u64,
    pub final_value: i128,
    pub profit: i128,
    pub trader_fee: i128,
    pub platform_fee: i128,
    pub customer_payout: i128,
    /// Address passed as `caller` to `settle`.
    pub by: Address,
}

/// A holding that could not be liquidated at settlement (no route to the
/// base token, or dust that quotes to 0) was handed to the customer in
/// kind. `delivered == false` means the customer could not receive it
/// (e.g. missing trustline); it stays in the vault until `claim`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unliquidated {
    #[topic]
    pub id: u64,
    pub token: Address,
    pub amount: i128,
    pub delivered: bool,
}

/// Customer collected an in-kind leg left behind by `settle`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub id: u64,
    pub token: Address,
    pub amount: i128,
}

/// Admin changed a config field. `key` names the field group that changed
/// ("router", "fees", "paused", "slippage"); the data carries the full
/// post-change config (minus admin).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigChanged {
    #[topic]
    pub key: Symbol,
    pub router: Address,
    pub platform_fee_bps: u32,
    pub fee_recipient: Address,
    pub paused: bool,
    pub settle_slippage_bps: u32,
}

/// Admin changed the token allow-list.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenSet {
    #[topic]
    pub token: Address,
    pub allowed: bool,
    pub is_base: bool,
}

/// Admin upgraded the contract code.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    pub wasm_hash: BytesN<32>,
}
