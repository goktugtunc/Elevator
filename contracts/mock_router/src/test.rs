#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal,
};

use crate::{MockRouter, MockRouterClient, RouterError};

struct Ctx {
    env: Env,
    admin: Address,
    user: Address,
    a: Address,
    b: Address,
    router: Address,
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let a = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let b = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let router = env.register(MockRouter, (admin.clone(),));
    // liquidity for the mock + funds for the user
    StellarAssetClient::new(&env, &a).mint(&router, &1_000_000);
    StellarAssetClient::new(&env, &b).mint(&router, &1_000_000);
    StellarAssetClient::new(&env, &a).mint(&user, &10_000);
    Ctx {
        env,
        admin,
        user,
        a,
        b,
        router,
    }
}

#[test]
fn quote_and_swap() {
    let c = setup();
    let client = MockRouterClient::new(&c.env, &c.router);
    client.set_price(&c.a, &c.b, &3, &2); // 1 A = 1.5 B

    let path = vec![&c.env, c.a.clone(), c.b.clone()];
    assert_eq!(client.router_get_amounts_out(&1_000, &path), vec![&c.env, 1_000, 1_500]);
    assert_eq!(client.router_pair_for(&c.a, &c.b), c.router);

    let out = client.swap_exact_tokens_for_tokens(&1_000, &1_500, &path, &c.user, &100);
    // `to` had to authorise the swap (assert before any other invocation).
    assert_eq!(c.env.auths()[0].0, c.user);
    assert_eq!(out, vec![&c.env, 1_000, 1_500]);
    assert_eq!(TokenClient::new(&c.env, &c.a).balance(&c.user), 9_000);
    assert_eq!(TokenClient::new(&c.env, &c.b).balance(&c.user), 1_500);
    assert_eq!(TokenClient::new(&c.env, &c.a).balance(&c.router), 1_001_000);
}

#[test]
fn errors() {
    let c = setup();
    let client = MockRouterClient::new(&c.env, &c.router);
    let path = vec![&c.env, c.a.clone(), c.b.clone()];

    assert_eq!(
        client.try_router_get_amounts_out(&1_000, &path),
        Err(Ok(RouterError::NoPrice))
    );
    client.set_price(&c.a, &c.b, &1, &1);
    assert_eq!(
        client.try_router_get_amounts_out(&0, &path),
        Err(Ok(RouterError::InvalidAmount))
    );
    assert_eq!(
        client.try_router_get_amounts_out(&10, &vec![&c.env, c.a.clone()]),
        Err(Ok(RouterError::InvalidPath))
    );
    assert_eq!(
        client.try_swap_exact_tokens_for_tokens(&1_000, &1_001, &path, &c.user, &100),
        Err(Ok(RouterError::InsufficientOutput))
    );
    c.env.ledger().set_timestamp(200);
    assert_eq!(
        client.try_swap_exact_tokens_for_tokens(&1_000, &1_000, &path, &c.user, &100),
        Err(Ok(RouterError::DeadlineExpired))
    );
    // lenient mode ignores amount_out_min
    client.set_strict(&false);
    assert!(client
        .try_swap_exact_tokens_for_tokens(&1_000, &5_000, &path, &c.user, &1_000)
        .is_ok());
    assert_eq!(
        client.try_set_price(&c.a, &c.b, &0, &1),
        Err(Ok(RouterError::InvalidAmount))
    );
}

#[test]
fn admin_only() {
    let c = setup();
    let client = MockRouterClient::new(&c.env, &c.router);
    let intruder = Address::generate(&c.env);
    c.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &c.router,
            fn_name: "set_price",
            args: (&c.a, &c.b, 1i128, 1i128).into_val(&c.env),
            sub_invokes: &[],
        },
    }]);
    assert!(client.try_set_price(&c.a, &c.b, &1, &1).is_err());
    assert!(client.try_set_strict(&false).is_err());
    assert!(client.try_withdraw(&c.a, &intruder, &1).is_err());

    c.env.mock_all_auths();
    client.withdraw(&c.a, &c.admin, &10);
    assert_eq!(TokenClient::new(&c.env, &c.a).balance(&c.admin), 10);
}
