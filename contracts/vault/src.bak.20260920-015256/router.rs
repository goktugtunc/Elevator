//! Typed client for the Soroswap router subset the vault uses. Declared as a
//! `#[contractclient]` trait so no WASM import is needed; the mock router in
//! `contracts/mock_router` implements the same three functions.

use soroban_sdk::{contractclient, Address, Env, Vec};

#[contractclient(name = "RouterClient")]
pub trait SoroswapRouter {
    /// Swaps `amount_in` of `path[0]` for at least `amount_out_min` of
    /// `path[last]`, sending the output to `to`. Requires `to.require_auth()`
    /// and pulls `amount_in` from `to` via `path[0].transfer(to, pair, ..)`.
    fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        deadline: u64,
    ) -> Vec<i128>;

    /// Read-only quote: `[amount_in, ..., amount_out]` along `path`.
    fn router_get_amounts_out(env: Env, amount_in: i128, path: Vec<Address>) -> Vec<i128>;

    /// Address of the pair contract for (token_a, token_b).
    fn router_pair_for(env: Env, token_a: Address, token_b: Address) -> Address;
}
