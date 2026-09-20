//! Mock of the Soroswap router subset used by `elevator_vault`
//! (tests + testnet fallback). Same signatures and auth semantics as
//! Soroswap: `swap_exact_tokens_for_tokens` does `to.require_auth()`, pulls
//! `amount_in` from `to` and pays the output from its own balance.
//! Prices are fixed `(num, den)` ratios per ordered pair set by the admin;
//! `router_pair_for` returns the router's own address so the pulled tokens
//! land in the mock.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token::TokenClient, vec, Address, Env,
    Vec,
};

#[cfg(test)]
mod test;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    NotInitialized = 1,
    NoPrice = 2,
    InvalidPath = 3,
    InsufficientOutput = 4,
    DeadlineExpired = 5,
    InvalidAmount = 6,
    Overflow = 7,
}

#[contracttype]
#[derive(Clone)]
pub enum RouterKey {
    Admin,
    /// When false the router skips its own `amount_out_min` check. Used to
    /// test the vault's independent re-check of the delivered amount.
    Strict,
    Price(Address, Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Price {
    pub num: i128,
    pub den: i128,
}

#[contract]
pub struct MockRouter;

fn require_admin(env: &Env) -> Result<(), RouterError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&RouterKey::Admin)
        .ok_or(RouterError::NotInitialized)?;
    admin.require_auth();
    Ok(())
}

fn amounts_out(env: &Env, amount_in: i128, path: &Vec<Address>) -> Result<Vec<i128>, RouterError> {
    if amount_in <= 0 {
        return Err(RouterError::InvalidAmount);
    }
    if path.len() < 2 {
        return Err(RouterError::InvalidPath);
    }
    let mut amounts = vec![env, amount_in];
    let mut current = amount_in;
    let mut i: u32 = 0;
    while i + 1 < path.len() {
        let a = path.get(i).ok_or(RouterError::InvalidPath)?;
        let b = path.get(i + 1).ok_or(RouterError::InvalidPath)?;
        let price: Price = env
            .storage()
            .instance()
            .get(&RouterKey::Price(a, b))
            .ok_or(RouterError::NoPrice)?;
        current = current
            .checked_mul(price.num)
            .ok_or(RouterError::Overflow)?
            .checked_div(price.den)
            .ok_or(RouterError::Overflow)?;
        amounts.push_back(current);
        i += 1;
    }
    Ok(amounts)
}

#[contractimpl]
impl MockRouter {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&RouterKey::Admin, &admin);
        env.storage().instance().set(&RouterKey::Strict, &true);
    }

    /// Admin: sets the price of `token_in -> token_out` to `num / den`.
    pub fn set_price(
        env: Env,
        token_in: Address,
        token_out: Address,
        num: i128,
        den: i128,
    ) -> Result<(), RouterError> {
        require_admin(&env)?;
        if num <= 0 || den <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&RouterKey::Price(token_in, token_out), &Price { num, den });
        Ok(())
    }

    /// Admin: removes the price of `token_in -> token_out` (a pool that lost
    /// its liquidity; quotes and swaps along it fail with `NoPrice`).
    pub fn clear_price(env: Env, token_in: Address, token_out: Address) -> Result<(), RouterError> {
        require_admin(&env)?;
        env.storage()
            .instance()
            .remove(&RouterKey::Price(token_in, token_out));
        Ok(())
    }

    /// Admin: toggles the router-side `amount_out_min` check (default on).
    pub fn set_strict(env: Env, strict: bool) -> Result<(), RouterError> {
        require_admin(&env)?;
        env.storage().instance().set(&RouterKey::Strict, &strict);
        Ok(())
    }

    /// Admin: withdraws liquidity held by the mock (testnet clean-up).
    pub fn withdraw(env: Env, token: Address, to: Address, amount: i128) -> Result<(), RouterError> {
        require_admin(&env)?;
        if amount <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        TokenClient::new(&env, &token).transfer(&env.current_contract_address(), &to, &amount);
        Ok(())
    }

    /// `[amount_in, ..., amount_out]` along `path`; error if a pair has no price.
    pub fn router_get_amounts_out(
        env: Env,
        amount_in: i128,
        path: Vec<Address>,
    ) -> Result<Vec<i128>, RouterError> {
        amounts_out(&env, amount_in, &path)
    }

    /// The mock is its own "pair" for every token combination.
    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.current_contract_address()
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Result<Vec<i128>, RouterError> {
        to.require_auth();
        if env.ledger().timestamp() > deadline {
            return Err(RouterError::DeadlineExpired);
        }
        let amounts = amounts_out(&env, amount_in, &path)?;
        let amount_out = amounts.last().ok_or(RouterError::InvalidPath)?;
        let strict: bool = env.storage().instance().get(&RouterKey::Strict).unwrap_or(true);
        if strict && amount_out < amount_out_min {
            return Err(RouterError::InsufficientOutput);
        }
        let token_in = path.first().ok_or(RouterError::InvalidPath)?;
        let token_out = path.last().ok_or(RouterError::InvalidPath)?;
        let this = env.current_contract_address();
        // Same shape as Soroswap: pull from `to` into the pair (= self) ...
        TokenClient::new(&env, &token_in).transfer(&to, &this, &amount_in);
        // ... then the pair sends the output to `to`.
        TokenClient::new(&env, &token_out).transfer(&this, &to, &amount_out);
        Ok(amounts)
    }
}
