//! Storage helpers. Every persistent write bumps the entry's TTL; the
//! instance TTL is bumped at the start of every mutating entry point.
//! No `unwrap()` on reads: absence is mapped to a typed error or to a
//! documented default.

use soroban_sdk::{Address, Env};

use crate::errors::Error;
use crate::types::{
    Agreement, Config, DataKey, Reservation, TokenInfo, TTL_EXTEND_TO, TTL_THRESHOLD,
};

pub fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn bump_persistent(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

// ---- Config ---------------------------------------------------------------

pub fn get_config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

pub fn set_config(env: &Env, cfg: &Config) {
    env.storage().instance().set(&DataKey::Config, cfg);
}

// ---- Ids ------------------------------------------------------------------

/// Id that the next `propose`/`open` will receive.
pub fn peek_next_id(env: &Env) -> u64 {
    // Absent only before the constructor ran; 1 is the first id ever issued.
    env.storage().instance().get(&DataKey::NextId).unwrap_or(1)
}

/// Allocates and returns a fresh agreement id.
pub fn take_next_id(env: &Env) -> Result<u64, Error> {
    let id = peek_next_id(env);
    let next = id.checked_add(1).ok_or(Error::Overflow)?;
    env.storage().instance().set(&DataKey::NextId, &next);
    Ok(id)
}

/// Id that the next `reserve` will receive. Counted separately from
/// agreement ids so neither sequence leaks the other's volume.
pub fn peek_next_reservation_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextReservationId)
        .unwrap_or(1)
}

/// Allocates and returns a fresh reservation id.
pub fn take_next_reservation_id(env: &Env) -> Result<u64, Error> {
    let id = peek_next_reservation_id(env);
    let next = id.checked_add(1).ok_or(Error::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::NextReservationId, &next);
    Ok(id)
}

// ---- Reservations ---------------------------------------------------------

pub fn get_reservation(env: &Env, id: u64) -> Result<Reservation, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Reservation(id))
        .ok_or(Error::ReservationNotFound)
}

pub fn set_reservation(env: &Env, res: &Reservation) {
    let key = DataKey::Reservation(res.id);
    env.storage().persistent().set(&key, res);
    bump_persistent(env, &key);
}

// ---- Agreements -----------------------------------------------------------

pub fn get_agreement(env: &Env, id: u64) -> Result<Agreement, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Agreement(id))
        .ok_or(Error::NotFound)
}

pub fn set_agreement(env: &Env, ag: &Agreement) {
    let key = DataKey::Agreement(ag.id);
    env.storage().persistent().set(&key, ag);
    bump_persistent(env, &key);
}

// ---- Balances -------------------------------------------------------------

/// Balance of `token` held for agreement `id`. A missing entry means the
/// agreement holds none of that token, hence the 0 default.
pub fn get_balance(env: &Env, id: u64, token: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(id, token.clone()))
        .unwrap_or(0)
}

pub fn set_balance(env: &Env, id: u64, token: &Address, amount: i128) {
    let key = DataKey::Balance(id, token.clone());
    env.storage().persistent().set(&key, &amount);
    bump_persistent(env, &key);
}

pub fn remove_balance(env: &Env, id: u64, token: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Balance(id, token.clone()));
}

// ---- Token allow-list -----------------------------------------------------

/// Unknown tokens are simply not allowed.
pub fn get_token_info(env: &Env, token: &Address) -> TokenInfo {
    env.storage()
        .instance()
        .get(&DataKey::AllowedToken(token.clone()))
        .unwrap_or(TokenInfo {
            allowed: false,
            is_base: false,
        })
}

pub fn set_token_info(env: &Env, token: &Address, info: &TokenInfo) {
    env.storage()
        .instance()
        .set(&DataKey::AllowedToken(token.clone()), info);
}
