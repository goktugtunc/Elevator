//! TraderKirala vault — a singleton escrow contract for customer/trader
//! capital-management agreements on Stellar (DESIGN.md §1).
//!
//! Capital never leaves the contract until settlement: the trader may only
//! swap it through the allow-listed router between allow-listed tokens, and
//! every trade is bounded by the agreement's max drawdown. Settlement
//! liquidates to the base token and splits profit per the agreed commission.
#![no_std]

mod errors;
mod events;
mod math;
mod router;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use errors::Error;
pub use events::*;
pub use router::{RouterClient, SoroswapRouter};
pub use types::*;

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contractmeta, symbol_short,
    token::TokenClient,
    vec, Address, BytesN, ContractExecutable, Env, IntoVal, Symbol, Vec,
};

contractmeta!(key = "binver", val = "1.1.0");
contractmeta!(key = "desc", val = "TraderKirala escrow vault");

#[contract]
pub struct TraderKiralaVault;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn require_admin(env: &Env) -> Result<Config, Error> {
    let cfg = storage::get_config(env)?;
    cfg.admin.require_auth();
    Ok(cfg)
}

fn emit_config_changed(env: &Env, key: Symbol, cfg: &Config) {
    ConfigChanged {
        key,
        router: cfg.router.clone(),
        platform_fee_bps: cfg.platform_fee_bps,
        fee_recipient: cfg.fee_recipient.clone(),
        paused: cfg.paused,
        settle_slippage_bps: cfg.settle_slippage_bps,
    }
    .publish(env);
}

fn validate_terms(env: &Env, terms: &Terms) -> Result<(), Error> {
    if terms.principal <= 0 {
        return Err(Error::InvalidTerms);
    }
    if terms.duration_secs < MIN_DURATION || terms.duration_secs > MAX_DURATION {
        return Err(Error::InvalidTerms);
    }
    if terms.commission_bps > MAX_COMMISSION_BPS {
        return Err(Error::InvalidTerms);
    }
    if terms.max_drawdown_bps < MIN_DRAWDOWN_BPS || terms.max_drawdown_bps > BPS_DENOM as u32 {
        return Err(Error::InvalidTerms);
    }
    if terms.customer == terms.trader {
        return Err(Error::InvalidTerms);
    }
    let info = storage::get_token_info(env, &terms.base_token);
    if !(info.allowed && info.is_base) {
        return Err(Error::TokenNotAllowed);
    }
    Ok(())
}

fn new_agreement(env: &Env, id: u64, terms: Terms, status: Status, proposer: Address) -> Agreement {
    let base = terms.base_token.clone();
    let principal = terms.principal;
    Agreement {
        id,
        terms,
        status,
        proposer,
        created_at: env.ledger().timestamp(),
        start_time: 0,
        end_time: 0,
        tokens: vec![env, base],
        settled_at: 0,
        final_value: 0,
        trader_fee: 0,
        platform_fee: 0,
        customer_payout: 0,
        last_value: principal,
    }
}

/// Pulls the principal from the customer into the contract and credits the
/// agreement's base balance. The customer's auth for this transfer is part
/// of the auth tree they signed for the outer `open`/`fund` call.
fn escrow_principal(env: &Env, ag: &Agreement) {
    let token = TokenClient::new(env, &ag.terms.base_token);
    token.transfer(
        &ag.terms.customer,
        env.current_contract_address(),
        &ag.terms.principal,
    );
    storage::set_balance(env, ag.id, &ag.terms.base_token, ag.terms.principal);
}

/// Sets start/end and flips the agreement to Active. Emits `Activated`.
fn activate(env: &Env, ag: &mut Agreement) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    ag.start_time = now;
    ag.end_time = now
        .checked_add(ag.terms.duration_secs)
        .ok_or(Error::Overflow)?;
    ag.status = Status::Active;
    storage::set_agreement(env, ag);
    Activated {
        id: ag.id,
        start_time: ag.start_time,
        end_time: ag.end_time,
    }
    .publish(env);
    Ok(())
}

/// Router quote of `amount` of `token` in `base`. A failing or empty quote
/// counts as 0 (conservative: unquotable holdings are worth nothing to the
/// drawdown check).
fn quote(env: &Env, router: &Address, token: &Address, base: &Address, amount: i128) -> i128 {
    if amount <= 0 {
        return 0;
    }
    let client = RouterClient::new(env, router);
    let path = vec![env, token.clone(), base.clone()];
    match client.try_router_get_amounts_out(&amount, &path) {
        Ok(Ok(amounts)) => {
            let q = amounts.last().unwrap_or(0);
            if q > 0 {
                q
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Portfolio value in base token (§1.3), plus the quote of the `probe`
/// token's holding from the same pass (0 when `probe` is the base token or
/// is not held), so callers that need one token's quote pay no extra router
/// call. Bounded by MAX_TOKENS.
fn valuation(
    env: &Env,
    router: &Address,
    ag: &Agreement,
    probe: &Address,
) -> Result<(i128, i128), Error> {
    let base = &ag.terms.base_token;
    let mut total = storage::get_balance(env, ag.id, base);
    let mut probe_quote: i128 = 0;
    for token in ag.tokens.iter() {
        if token == *base {
            continue;
        }
        let bal = storage::get_balance(env, ag.id, &token);
        if bal <= 0 {
            continue;
        }
        let q = quote(env, router, &token, base, bal);
        if token == *probe {
            probe_quote = q;
        }
        total = total.checked_add(q).ok_or(Error::Overflow)?;
    }
    Ok((total, probe_quote))
}

/// Executes `token_in -> token_out` through the allow-listed router with the
/// vault as both payer and recipient. The vault pre-authorises the inner
/// `token_in.transfer(vault, pair, amount_in)` that the router performs.
/// Returns the router-reported output, which must be >= `min_out` and > 0.
/// Callers additionally verify the tokens actually received (balance
/// deltas) so a misbehaving router or token cannot inflate accounting.
fn swap_via_router(
    env: &Env,
    router: &Address,
    token_in: &Address,
    token_out: &Address,
    amount_in: i128,
    min_out: i128,
    deadline: u64,
) -> Result<i128, Error> {
    let this = env.current_contract_address();
    let router_client = RouterClient::new(env, router);

    let pair = match router_client.try_router_pair_for(token_in, token_out) {
        Ok(Ok(p)) => p,
        _ => return Err(Error::RouterError),
    };

    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token_in.clone(),
                fn_name: symbol_short!("transfer"),
                args: (this.clone(), pair, amount_in).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);

    let path = vec![env, token_in.clone(), token_out.clone()];
    let amounts = match router_client.try_swap_exact_tokens_for_tokens(
        &amount_in, &min_out, &path, &this, &deadline,
    ) {
        Ok(Ok(a)) => a,
        _ => return Err(Error::RouterError),
    };
    let reported = amounts.last().ok_or(Error::RouterError)?;
    if reported <= 0 || reported < min_out {
        return Err(Error::SlippageExceeded);
    }
    Ok(reported)
}

/// The smaller of what the router reported and what actually arrived.
fn credited(reported: i128, before: i128, after: i128) -> Result<i128, Error> {
    let received = after.checked_sub(before).ok_or(Error::Overflow)?;
    Ok(if received < reported { received } else { reported })
}

/// Pays `amount` of `token` from the vault to `to`. Fee legs use
/// `try_transfer` so a recipient whose account cannot receive the token
/// (e.g. missing trustline) can never block settlement; the failed leg is
/// returned so the caller can redirect it.
fn pay(env: &Env, token: &TokenClient, to: &Address, amount: i128) -> bool {
    if amount <= 0 {
        return true;
    }
    matches!(
        token.try_transfer(&env.current_contract_address(), to, &amount),
        Ok(Ok(()))
    )
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contractimpl]
impl TraderKiralaVault {
    /// Deploy-time initialisation. Validates the bps ranges.
    pub fn __constructor(
        env: Env,
        admin: Address,
        router: Address,
        fee_recipient: Address,
        platform_fee_bps: u32,
        settle_slippage_bps: u32,
    ) -> Result<(), Error> {
        if platform_fee_bps > MAX_PLATFORM_FEE_BPS || settle_slippage_bps > MAX_SETTLE_SLIPPAGE_BPS {
            return Err(Error::InvalidTerms);
        }
        storage::set_config(
            &env,
            &Config {
                admin,
                router,
                platform_fee_bps,
                fee_recipient,
                paused: false,
                settle_slippage_bps,
            },
        );
        env.storage().instance().set(&DataKey::NextId, &1u64);
        storage::extend_instance(&env);
        Ok(())
    }

    // ---- Admin ------------------------------------------------------------

    /// Allow-lists (or de-lists) a token. Only allow-listed tokens can be
    /// escrowed or traded; `is_base` marks tokens usable as `base_token`.
    pub fn set_token(env: Env, token: Address, allowed: bool, is_base: bool) -> Result<(), Error> {
        storage::extend_instance(&env);
        require_admin(&env)?;
        let info = TokenInfo {
            allowed,
            is_base: allowed && is_base,
        };
        storage::set_token_info(&env, &token, &info);
        TokenSet {
            token,
            allowed: info.allowed,
            is_base: info.is_base,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_router(env: Env, router: Address) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut cfg = require_admin(&env)?;
        cfg.router = router;
        storage::set_config(&env, &cfg);
        emit_config_changed(&env, symbol_short!("router"), &cfg);
        Ok(())
    }

    pub fn set_fees(env: Env, platform_fee_bps: u32, fee_recipient: Address) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut cfg = require_admin(&env)?;
        if platform_fee_bps > MAX_PLATFORM_FEE_BPS {
            return Err(Error::InvalidTerms);
        }
        cfg.platform_fee_bps = platform_fee_bps;
        cfg.fee_recipient = fee_recipient;
        storage::set_config(&env, &cfg);
        emit_config_changed(&env, symbol_short!("fees"), &cfg);
        Ok(())
    }

    /// Pausing blocks `propose/open/fund/accept/trade` only. `cancel` and
    /// `settle` keep working so user funds are never locked by the admin.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut cfg = require_admin(&env)?;
        cfg.paused = paused;
        storage::set_config(&env, &cfg);
        emit_config_changed(&env, symbol_short!("paused"), &cfg);
        Ok(())
    }

    pub fn set_settle_slippage(env: Env, bps: u32) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut cfg = require_admin(&env)?;
        if bps > MAX_SETTLE_SLIPPAGE_BPS {
            return Err(Error::InvalidTerms);
        }
        cfg.settle_slippage_bps = bps;
        storage::set_config(&env, &cfg);
        emit_config_changed(&env, symbol_short!("slippage"), &cfg);
        Ok(())
    }

    /// Replaces the contract code. Storage (agreements, balances, config)
    /// is untouched; the constructor does not re-run.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        storage::extend_instance(&env);
        require_admin(&env)?;
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(wasm_hash.clone()));
        Upgraded { wasm_hash }.publish(&env);
        Ok(())
    }

    // ---- Lifecycle --------------------------------------------------------

    /// Trader creates an agreement for `terms.customer` to fund later.
    pub fn propose(env: Env, trader: Address, terms: Terms) -> Result<u64, Error> {
        storage::extend_instance(&env);
        trader.require_auth();
        if storage::get_config(&env)?.paused {
            return Err(Error::Paused);
        }
        if trader != terms.trader {
            return Err(Error::Unauthorized);
        }
        validate_terms(&env, &terms)?;
        let id = storage::take_next_id(&env)?;
        let ag = new_agreement(&env, id, terms, Status::Proposed, trader);
        storage::set_agreement(&env, &ag);
        Proposed {
            id,
            trader: ag.terms.trader.clone(),
            customer: ag.terms.customer.clone(),
            principal: ag.terms.principal,
            base_token: ag.terms.base_token.clone(),
        }
        .publish(&env);
        Ok(id)
    }

    /// Customer creates and funds an agreement for `terms.trader` to accept.
    pub fn open(env: Env, customer: Address, terms: Terms) -> Result<u64, Error> {
        storage::extend_instance(&env);
        customer.require_auth();
        if storage::get_config(&env)?.paused {
            return Err(Error::Paused);
        }
        if customer != terms.customer {
            return Err(Error::Unauthorized);
        }
        validate_terms(&env, &terms)?;
        let id = storage::take_next_id(&env)?;
        let ag = new_agreement(&env, id, terms, Status::Funded, customer);
        escrow_principal(&env, &ag);
        storage::set_agreement(&env, &ag);
        Opened {
            id,
            trader: ag.terms.trader.clone(),
            customer: ag.terms.customer.clone(),
            principal: ag.terms.principal,
            base_token: ag.terms.base_token.clone(),
        }
        .publish(&env);
        Ok(id)
    }

    /// Customer funds a Proposed agreement -> Active.
    pub fn fund(env: Env, id: u64) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut ag = storage::get_agreement(&env, id)?;
        ag.terms.customer.require_auth();
        if storage::get_config(&env)?.paused {
            return Err(Error::Paused);
        }
        if ag.status != Status::Proposed {
            return Err(Error::WrongStatus);
        }
        // Re-check the base token is still a valid base at funding time.
        let info = storage::get_token_info(&env, &ag.terms.base_token);
        if !(info.allowed && info.is_base) {
            return Err(Error::TokenNotAllowed);
        }
        escrow_principal(&env, &ag);
        activate(&env, &mut ag)
    }

    /// Trader accepts a Funded agreement -> Active.
    pub fn accept(env: Env, id: u64) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut ag = storage::get_agreement(&env, id)?;
        ag.terms.trader.require_auth();
        if storage::get_config(&env)?.paused {
            return Err(Error::Paused);
        }
        if ag.status != Status::Funded {
            return Err(Error::WrongStatus);
        }
        activate(&env, &mut ag)
    }

    /// Cancels a not-yet-active agreement. Proposed: only the proposer.
    /// Funded: customer or trader; the principal is refunded to the
    /// customer. Works while paused.
    pub fn cancel(env: Env, id: u64, caller: Address) -> Result<(), Error> {
        storage::extend_instance(&env);
        let mut ag = storage::get_agreement(&env, id)?;
        let allowed = match ag.status {
            Status::Proposed => caller == ag.proposer,
            Status::Funded => caller == ag.terms.customer || caller == ag.terms.trader,
            _ => return Err(Error::WrongStatus),
        };
        if !allowed {
            return Err(Error::NotParty);
        }
        caller.require_auth();

        let mut refunded: i128 = 0;
        if ag.status == Status::Funded {
            let base = &ag.terms.base_token;
            refunded = storage::get_balance(&env, id, base);
            if refunded > 0 {
                TokenClient::new(&env, base).transfer(
                    &env.current_contract_address(),
                    &ag.terms.customer,
                    &refunded,
                );
            }
            storage::remove_balance(&env, id, base);
        }
        ag.status = Status::Cancelled;
        storage::set_agreement(&env, &ag);
        Cancelled { id, refunded }.publish(&env);
        Ok(())
    }

    /// Trader swaps `amount_in` of `token_in` for `token_out` through the
    /// router. Rejected if the resulting portfolio value (router quotes)
    /// would breach the agreement's max drawdown. Returns the amount out.
    pub fn trade(
        env: Env,
        id: u64,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_out: i128,
        deadline: u64,
    ) -> Result<i128, Error> {
        storage::extend_instance(&env);
        let cfg = storage::get_config(&env)?;
        let mut ag = storage::get_agreement(&env, id)?;
        ag.terms.trader.require_auth();
        if cfg.paused {
            return Err(Error::Paused);
        }
        if ag.status != Status::Active {
            return Err(Error::WrongStatus);
        }
        let now = env.ledger().timestamp();
        if now >= ag.end_time || deadline < now {
            return Err(Error::Expired);
        }
        if amount_in <= 0 || min_out <= 0 {
            return Err(Error::InvalidAmount);
        }
        if token_in == token_out
            || !storage::get_token_info(&env, &token_in).allowed
            || !storage::get_token_info(&env, &token_out).allowed
        {
            return Err(Error::TokenNotAllowed);
        }
        let bal_in = storage::get_balance(&env, id, &token_in);
        if bal_in < amount_in {
            return Err(Error::InsufficientBalance);
        }
        let mut tokens = ag.tokens.clone();
        if !tokens.contains(&token_out) {
            if tokens.len() >= MAX_TOKENS {
                return Err(Error::TooManyTokens);
            }
            tokens.push_back(token_out.clone());
        }

        let this = env.current_contract_address();
        let out_token = TokenClient::new(&env, &token_out);
        let before = out_token.balance(&this);
        let reported = swap_via_router(
            &env, &cfg.router, &token_in, &token_out, amount_in, min_out, deadline,
        )?;
        let amount_out = credited(reported, before, out_token.balance(&this))?;
        if amount_out < min_out {
            return Err(Error::SlippageExceeded);
        }

        // Update accounting (checked). A fully exited non-base token leaves
        // the holdings list so it frees a MAX_TOKENS slot.
        let new_in = bal_in.checked_sub(amount_in).ok_or(Error::Overflow)?;
        if new_in == 0 && token_in != ag.terms.base_token {
            storage::remove_balance(&env, id, &token_in);
            if let Some(i) = tokens.first_index_of(&token_in) {
                tokens.remove(i);
            }
        } else {
            storage::set_balance(&env, id, &token_in, new_in);
        }
        let new_out = storage::get_balance(&env, id, &token_out)
            .checked_add(amount_out)
            .ok_or(Error::Overflow)?;
        storage::set_balance(&env, id, &token_out, new_out);
        ag.tokens = tokens;

        // Drawdown check on the post-trade portfolio. The same pass yields
        // the quote of the `token_out` holding: a non-base token that cannot
        // be quoted back to base (no `[token_out, base]` route) is refused,
        // so principal is never parked in something settlement cannot sell.
        let (value_after, out_quote) = valuation(&env, &cfg.router, &ag, &token_out)?;
        if token_out != ag.terms.base_token && out_quote <= 0 {
            return Err(Error::TokenNotAllowed);
        }
        let floor = math::drawdown_floor(ag.terms.principal, ag.terms.max_drawdown_bps)?;
        if value_after < floor {
            return Err(Error::DrawdownBreached);
        }
        ag.last_value = value_after;

        storage::set_agreement(&env, &ag);
        Traded {
            id,
            trader: ag.terms.trader.clone(),
            token_in,
            token_out,
            amount_in,
            amount_out,
            value_after,
        }
        .publish(&env);
        Ok(amount_out)
    }

    /// Liquidates every non-base holding to the base token and pays out.
    ///
    /// Who may call, and which floor protects each swap:
    /// * `caller` is the customer or the trader: any time, must authorise;
    ///   `min_outs` has one entry per non-base token in `tokens` order
    ///   (entries for zero balances are ignored) and is used as-is. A
    ///   trader-initiated settlement must additionally realise at least the
    ///   agreement's drawdown floor (same rule as `trade`).
    /// * `caller` is the admin: only from `end_time`, must authorise;
    ///   `min_outs` is either empty or one entry per non-base token, and each
    ///   floor is `max(min_outs[i], quote × (1 − settle_slippage_bps))`.
    /// * anyone else: only from `end_time + SETTLE_GRACE_SECS`, no auth,
    ///   `min_outs` as for the admin, and the realised value must be at least
    ///   `last_value × (1 − settle_slippage_bps)` — a reference recorded in an
    ///   earlier ledger, which a same-transaction pool manipulation cannot
    ///   lower.
    ///
    /// A holding whose quote in base is 0 (no route, or dust below one base
    /// unit) is handed to the customer in kind instead of blocking the
    /// settlement; if the customer cannot receive it, it stays claimable
    /// through `claim`. Works while paused.
    pub fn settle(env: Env, id: u64, caller: Address, min_outs: Vec<i128>) -> Result<(), Error> {
        storage::extend_instance(&env);
        let cfg = storage::get_config(&env)?;
        let mut ag = storage::get_agreement(&env, id)?;
        if ag.status != Status::Active {
            return Err(Error::WrongStatus);
        }
        let now = env.ledger().timestamp();
        let non_base = ag.tokens.len().checked_sub(1).ok_or(Error::Overflow)?;
        let is_customer = caller == ag.terms.customer;
        let is_trader = caller == ag.terms.trader;
        let is_party = is_customer || is_trader;
        let is_admin = !is_party && caller == cfg.admin;
        if is_party {
            caller.require_auth();
            if min_outs.len() != non_base {
                return Err(Error::InvalidAmount);
            }
        } else {
            if now < ag.end_time {
                return Err(Error::NotExpired);
            }
            if is_admin {
                caller.require_auth();
            } else if now < ag.end_time.saturating_add(SETTLE_GRACE_SECS) {
                return Err(Error::NotExpired);
            }
            if !min_outs.is_empty() && min_outs.len() != non_base {
                return Err(Error::InvalidAmount);
            }
        }
        let use_supplied = !min_outs.is_empty();

        let base = ag.terms.base_token.clone();
        let deadline = now.saturating_add(1);
        let this = env.current_contract_address();
        let base_client = TokenClient::new(&env, &base);
        let base_before = base_client.balance(&this);
        let mut reported_total: i128 = 0;
        let mut idx: u32 = 0;
        // Holdings that outlive the settlement: the base slot plus any
        // in-kind leg the customer could not receive.
        let mut kept: Vec<Address> = vec![&env, base.clone()];
        for token in ag.tokens.iter() {
            if token == base {
                continue;
            }
            let supplied = if use_supplied {
                let s = min_outs.get(idx).ok_or(Error::InvalidAmount)?;
                if s < 0 {
                    return Err(Error::InvalidAmount);
                }
                s
            } else {
                0
            };
            idx = idx.checked_add(1).ok_or(Error::Overflow)?;

            let bal = storage::get_balance(&env, id, &token);
            if bal <= 0 {
                storage::remove_balance(&env, id, &token);
                continue;
            }
            let q = quote(&env, &cfg.router, &token, &base, bal);
            if q <= 0 {
                let delivered = pay(&env, &TokenClient::new(&env, &token), &ag.terms.customer, bal);
                if delivered {
                    storage::remove_balance(&env, id, &token);
                } else {
                    kept.push_back(token.clone());
                }
                Unliquidated {
                    id,
                    token: token.clone(),
                    amount: bal,
                    delivered,
                }
                .publish(&env);
                continue;
            }
            let min_out = if is_party {
                supplied
            } else {
                let floor = math::min_out_with_slippage(q, cfg.settle_slippage_bps)?;
                if supplied > floor {
                    supplied
                } else {
                    floor
                }
            };
            let out = swap_via_router(&env, &cfg.router, &token, &base, bal, min_out, deadline)?;
            reported_total = reported_total.checked_add(out).ok_or(Error::Overflow)?;
            storage::remove_balance(&env, id, &token);
        }

        // Credit what actually arrived (never more than the router reported).
        let liquidated = credited(reported_total, base_before, base_client.balance(&this))?;
        let final_value = storage::get_balance(&env, id, &base)
            .checked_add(liquidated)
            .ok_or(Error::Overflow)?;

        // Floors that no same-transaction quote can satisfy on its own.
        if is_trader {
            let floor = math::drawdown_floor(ag.terms.principal, ag.terms.max_drawdown_bps)?;
            if final_value < floor {
                return Err(Error::DrawdownBreached);
            }
        }
        if !is_party && !is_admin {
            let floor = math::min_out_with_slippage(ag.last_value, cfg.settle_slippage_bps)?;
            if final_value < floor {
                return Err(Error::SlippageExceeded);
            }
        }

        let split = math::settlement(
            final_value,
            ag.terms.principal,
            ag.terms.commission_bps,
            cfg.platform_fee_bps,
        )?;
        let mut trader_fee = split.trader_fee;
        let mut platform_fee = split.platform_fee;
        let mut customer_payout = split.customer_payout;

        // Fee legs first; a leg the recipient cannot receive is folded into
        // the customer payout instead of blocking settlement.
        if !pay(&env, &base_client, &ag.terms.trader, trader_fee) {
            customer_payout = customer_payout.checked_add(trader_fee).ok_or(Error::Overflow)?;
            trader_fee = 0;
        }
        if !pay(&env, &base_client, &cfg.fee_recipient, platform_fee) {
            customer_payout = customer_payout.checked_add(platform_fee).ok_or(Error::Overflow)?;
            platform_fee = 0;
        }
        if customer_payout > 0 {
            base_client.transfer(&this, &ag.terms.customer, &customer_payout);
        }
        storage::remove_balance(&env, id, &base);

        ag.status = Status::Settled;
        ag.settled_at = now;
        ag.final_value = final_value;
        ag.trader_fee = trader_fee;
        ag.platform_fee = platform_fee;
        ag.customer_payout = customer_payout;
        ag.last_value = final_value;
        ag.tokens = kept;
        storage::set_agreement(&env, &ag);

        Settled {
            id,
            final_value,
            profit: split.profit,
            trader_fee,
            platform_fee,
            customer_payout,
            by: caller,
        }
        .publish(&env);
        Ok(())
    }

    /// Customer collects an in-kind settlement leg that `settle` could not
    /// deliver (`Unliquidated{delivered: false}`). Returns the amount sent.
    /// Works while paused.
    pub fn claim(env: Env, id: u64, token: Address) -> Result<i128, Error> {
        storage::extend_instance(&env);
        let mut ag = storage::get_agreement(&env, id)?;
        ag.terms.customer.require_auth();
        if ag.status != Status::Settled {
            return Err(Error::WrongStatus);
        }
        let amount = storage::get_balance(&env, id, &token);
        if amount <= 0 {
            return Err(Error::InsufficientBalance);
        }
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &ag.terms.customer,
            &amount,
        );
        storage::remove_balance(&env, id, &token);
        if let Some(i) = ag.tokens.first_index_of(&token) {
            if i > 0 {
                ag.tokens.remove(i);
            }
        }
        storage::set_agreement(&env, &ag);
        Claimed { id, token, amount }.publish(&env);
        Ok(amount)
    }

    // ---- Views ------------------------------------------------------------

    pub fn get_agreement(env: Env, id: u64) -> Result<Agreement, Error> {
        storage::get_agreement(&env, id)
    }

    /// `(token, balance)` for every token in the agreement's holdings list.
    pub fn get_balances(env: Env, id: u64) -> Result<Vec<(Address, i128)>, Error> {
        let ag = storage::get_agreement(&env, id)?;
        let mut out: Vec<(Address, i128)> = Vec::new(&env);
        for token in ag.tokens.iter() {
            let bal = storage::get_balance(&env, id, &token);
            out.push_back((token, bal));
        }
        Ok(out)
    }

    /// Portfolio value in base token using router quotes (0 for a token
    /// without a path).
    pub fn value_in_base(env: Env, id: u64) -> Result<i128, Error> {
        let cfg = storage::get_config(&env)?;
        let ag = storage::get_agreement(&env, id)?;
        Ok(valuation(&env, &cfg.router, &ag, &ag.terms.base_token)?.0)
    }

    pub fn get_config(env: Env) -> Result<Config, Error> {
        storage::get_config(&env)
    }

    pub fn is_token_allowed(env: Env, token: Address) -> Result<TokenInfo, Error> {
        Ok(storage::get_token_info(&env, &token))
    }

    /// Id the next `propose`/`open` will be assigned.
    pub fn next_id(env: Env) -> Result<u64, Error> {
        Ok(storage::peek_next_id(&env))
    }
}
