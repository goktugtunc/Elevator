#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, AuthorizedFunction, AuthorizedInvocation, BytesN as _, Events as _,
        IssuerFlags, Ledger as _, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, Event as _, IntoVal, Symbol, Vec,
};
use traderkirala_mock_router::{MockRouter, MockRouterClient};

use crate::{
    math, Activated, Agreement, Cancelled, Claimed, Config, ConfigChanged, DataKey, Error,
    Opened, Proposed, Settled, Status, Terms, TokenInfo, TokenSet, TraderKiralaVault,
    TraderKiralaVaultClient, Traded, Unliquidated, MAX_TOKENS, SETTLE_GRACE_SECS, TTL_EXTEND_TO,
};

const UNIT: i128 = 10_000_000; // 7 dp
const PRINCIPAL: i128 = 1_000 * UNIT;
const DAY: u64 = 86_400;
const DURATION: u64 = 30 * DAY;
const START_TS: u64 = 1_700_000_000;
const LIQ: i128 = 1_000_000_000 * UNIT;
const PLATFORM_FEE_BPS: u32 = 100; // 1%
const SETTLE_SLIPPAGE_BPS: u32 = 100; // 1%

struct Ctx {
    env: Env,
    admin: Address,
    customer: Address,
    trader: Address,
    fee_recipient: Address,
    stranger: Address,
    usdc: Address,
    xlm: Address,
    eurc: Address,
    router: Address,
    vault: Address,
}

impl Ctx {
    fn client(&self) -> TraderKiralaVaultClient<'_> {
        TraderKiralaVaultClient::new(&self.env, &self.vault)
    }
    fn router(&self) -> MockRouterClient<'_> {
        MockRouterClient::new(&self.env, &self.router)
    }
    fn mint(&self, token: &Address, to: &Address, amount: i128) {
        StellarAssetClient::new(&self.env, token).mint(to, &amount);
    }
    fn bal(&self, token: &Address, who: &Address) -> i128 {
        TokenClient::new(&self.env, token).balance(who)
    }
    fn set_price(&self, a: &Address, b: &Address, num: i128, den: i128) {
        self.router().set_price(a, b, &num, &den);
    }
    fn clear_price(&self, a: &Address, b: &Address) {
        self.router().clear_price(a, b);
    }
    /// SAC admin switch: a deauthorised balance cannot receive the token,
    /// which is what a missing trustline looks like from the contract side.
    fn set_authorized(&self, token: &Address, who: &Address, ok: bool) {
        StellarAssetClient::new(&self.env, token).set_authorized(who, &ok);
    }
    fn new_token(&self, allowed: bool, is_base: bool) -> Address {
        let t = self
            .env
            .register_stellar_asset_contract_v2(self.admin.clone())
            .address();
        self.client().set_token(&t, &allowed, &is_base);
        self.mint(&t, &self.router, LIQ);
        t
    }
    /// Allow-listed non-base token whose issuer has AUTH_REVOCABLE, so a
    /// balance can be deauthorised with `set_authorized` (see below).
    fn new_revocable_token(&self) -> Address {
        let sac = self
            .env
            .register_stellar_asset_contract_v2(self.admin.clone());
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        let t = sac.address();
        self.client().set_token(&t, &true, &false);
        self.mint(&t, &self.router, LIQ);
        t
    }
    fn terms(&self) -> Terms {
        Terms {
            customer: self.customer.clone(),
            trader: self.trader.clone(),
            base_token: self.usdc.clone(),
            principal: PRINCIPAL,
            duration_secs: DURATION,
            commission_bps: 2_000,
            max_drawdown_bps: 2_000,
            listing_ref: BytesN::random(&self.env),
        }
    }
    /// open (customer) + accept (trader) -> Active
    fn open_active(&self) -> u64 {
        let id = self.client().open(&self.customer, &self.terms());
        self.client().accept(&id);
        id
    }
    /// propose (trader) + fund (customer) -> Active
    fn propose_active(&self) -> u64 {
        let id = self.client().propose(&self.trader, &self.terms());
        self.client().fund(&id);
        id
    }
    fn agreement(&self, id: u64) -> Agreement {
        self.client().get_agreement(&id)
    }
    fn vault_balance(&self, id: u64, token: &Address) -> i128 {
        self.client()
            .get_balances(&id)
            .iter()
            .find(|(t, _)| *t == *token)
            .map(|(_, b)| b)
            .unwrap_or(0)
    }
    fn now(&self) -> u64 {
        self.env.ledger().timestamp()
    }
}

fn setup() -> Ctx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TS);

    let admin = Address::generate(&env);
    let customer = Address::generate(&env);
    let trader = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let stranger = Address::generate(&env);

    let usdc = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let xlm = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let eurc = env.register_stellar_asset_contract_v2(admin.clone()).address();

    let router = env.register(MockRouter, (admin.clone(),));
    let vault = env.register(
        TraderKiralaVault,
        (
            admin.clone(),
            router.clone(),
            fee_recipient.clone(),
            PLATFORM_FEE_BPS,
            SETTLE_SLIPPAGE_BPS,
        ),
    );

    let ctx = Ctx {
        env,
        admin,
        customer,
        trader,
        fee_recipient,
        stranger,
        usdc,
        xlm,
        eurc,
        router,
        vault,
    };
    let c = ctx.client();
    c.set_token(&ctx.usdc, &true, &true);
    c.set_token(&ctx.xlm, &true, &true);
    c.set_token(&ctx.eurc, &true, &false);

    ctx.mint(&ctx.usdc, &ctx.customer, PRINCIPAL);
    for t in [&ctx.usdc, &ctx.xlm, &ctx.eurc] {
        ctx.mint(t, &ctx.router, LIQ);
    }
    // 1 USDC = 4 XLM, 1 USDC = 0.9 EURC
    ctx.set_price(&ctx.usdc, &ctx.xlm, 4, 1);
    ctx.set_price(&ctx.xlm, &ctx.usdc, 1, 4);
    ctx.set_price(&ctx.usdc, &ctx.eurc, 9, 10);
    ctx.set_price(&ctx.eurc, &ctx.usdc, 10, 9);
    ctx
}

fn auth_root(
    env: &Env,
    contract: &Address,
    f: &str,
    args: Vec<soroban_sdk::Val>,
    subs: std::vec::Vec<AuthorizedInvocation>,
) -> AuthorizedInvocation {
    AuthorizedInvocation {
        function: AuthorizedFunction::Contract((contract.clone(), Symbol::new(env, f), args)),
        sub_invocations: subs,
    }
}

// ===========================================================================
// Constructor / config / admin
// ===========================================================================

#[test]
fn constructor_sets_config_and_ids() {
    let c = setup();
    assert_eq!(
        c.client().get_config(),
        Config {
            admin: c.admin.clone(),
            router: c.router.clone(),
            platform_fee_bps: PLATFORM_FEE_BPS,
            fee_recipient: c.fee_recipient.clone(),
            paused: false,
            settle_slippage_bps: SETTLE_SLIPPAGE_BPS,
        }
    );
    assert_eq!(c.client().next_id(), 1);
    let ttl = c
        .env
        .as_contract(&c.vault, || c.env.storage().instance().get_ttl());
    assert!(ttl >= TTL_EXTEND_TO - 1, "instance ttl {ttl}");
}

#[test]
#[should_panic]
fn constructor_rejects_platform_fee_above_cap() {
    let env = Env::default();
    let a = Address::generate(&env);
    env.register(
        TraderKiralaVault,
        (a.clone(), a.clone(), a.clone(), 1_001u32, 100u32),
    );
}

#[test]
#[should_panic]
fn constructor_rejects_slippage_above_cap() {
    let env = Env::default();
    let a = Address::generate(&env);
    env.register(
        TraderKiralaVault,
        (a.clone(), a.clone(), a.clone(), 0u32, 5_001u32),
    );
}

#[test]
fn admin_token_allow_list() {
    let c = setup();
    let t = Address::generate(&c.env);
    assert_eq!(
        c.client().is_token_allowed(&t),
        TokenInfo {
            allowed: false,
            is_base: false
        }
    );
    c.client().set_token(&t, &true, &true);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![TokenSet {
            token: t.clone(),
            allowed: true,
            is_base: true
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(
        c.client().is_token_allowed(&t),
        TokenInfo {
            allowed: true,
            is_base: true
        }
    );
    // de-listing clears is_base regardless of the flag passed
    c.client().set_token(&t, &false, &true);
    assert_eq!(
        c.client().is_token_allowed(&t),
        TokenInfo {
            allowed: false,
            is_base: false
        }
    );
}

#[test]
fn admin_config_changes_emit_events_and_validate() {
    let c = setup();
    let cl = c.client();
    let new_router = Address::generate(&c.env);
    let new_fee = Address::generate(&c.env);

    cl.set_router(&new_router);
    let cfg = cl.get_config();
    assert_eq!(cfg.router, new_router);

    cl.set_fees(&500, &new_fee);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![ConfigChanged {
            key: Symbol::new(&c.env, "fees"),
            router: new_router.clone(),
            platform_fee_bps: 500,
            fee_recipient: new_fee.clone(),
            paused: false,
            settle_slippage_bps: SETTLE_SLIPPAGE_BPS,
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(cl.try_set_fees(&1_001, &new_fee), Err(Ok(Error::InvalidTerms)));

    cl.set_paused(&true);
    assert!(cl.get_config().paused);
    cl.set_paused(&false);

    cl.set_settle_slippage(&250);
    assert_eq!(cl.get_config().settle_slippage_bps, 250);
    assert_eq!(cl.try_set_settle_slippage(&5_001), Err(Ok(Error::InvalidTerms)));
}

#[test]
fn admin_functions_reject_non_admin() {
    let c = setup();
    let cl = c.client();
    let t = Address::generate(&c.env);
    // Sign every call as `stranger`; the contract requires `config.admin`.
    let mock = |f: &'static str, args: Vec<soroban_sdk::Val>| {
        c.env.mock_auths(&[MockAuth {
            address: &c.stranger,
            invoke: &MockAuthInvoke {
                contract: &c.vault,
                fn_name: f,
                args,
                sub_invokes: &[],
            },
        }]);
    };
    mock("set_token", (&t, true, true).into_val(&c.env));
    assert!(cl.try_set_token(&t, &true, &true).is_err());
    mock("set_router", (&t,).into_val(&c.env));
    assert!(cl.try_set_router(&t).is_err());
    mock("set_fees", (0u32, &t).into_val(&c.env));
    assert!(cl.try_set_fees(&0, &t).is_err());
    mock("set_paused", (true,).into_val(&c.env));
    assert!(cl.try_set_paused(&true).is_err());
    mock("set_settle_slippage", (10u32,).into_val(&c.env));
    assert!(cl.try_set_settle_slippage(&10).is_err());
    let hash = BytesN::<32>::random(&c.env);
    mock("upgrade", (&hash,).into_val(&c.env));
    assert!(cl.try_upgrade(&hash).is_err());
    // nothing changed
    c.env.mock_all_auths();
    assert!(!cl.get_config().paused);
    assert_eq!(cl.get_config().router, c.router);
}

#[test]
fn upgrade_admin_path_reaches_deployer() {
    let c = setup();
    // Admin auth passes; the hash is not an uploaded wasm so the host
    // rejects the update (outer Err), i.e. it is *not* Unauthorized.
    let res = c.client().try_upgrade(&BytesN::<32>::random(&c.env));
    assert!(matches!(res, Err(Err(_))), "{res:?}");
}

// ===========================================================================
// Lifecycle: customer-initiated (open -> accept -> trade -> settle)
// ===========================================================================

#[test]
fn lifecycle_customer_initiated() {
    let c = setup();
    let cl = c.client();
    let terms = c.terms();

    // ---- open ----
    let id = cl.open(&c.customer, &terms);
    assert_eq!(id, 1);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.customer.clone(),
            auth_root(
                &c.env,
                &c.vault,
                "open",
                (&c.customer, terms.clone()).into_val(&c.env),
                std::vec![auth_root(
                    &c.env,
                    &c.usdc,
                    "transfer",
                    (&c.customer, &c.vault, PRINCIPAL).into_val(&c.env),
                    std::vec![],
                )],
            )
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Opened {
            id,
            trader: c.trader.clone(),
            customer: c.customer.clone(),
            principal: PRINCIPAL,
            base_token: c.usdc.clone(),
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(c.bal(&c.usdc, &c.customer), 0);
    assert_eq!(c.bal(&c.usdc, &c.vault), PRINCIPAL);
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Funded);
    assert_eq!(ag.proposer, c.customer);
    assert_eq!(ag.created_at, START_TS);
    assert_eq!((ag.start_time, ag.end_time), (0, 0));
    assert_eq!(ag.tokens, vec![&c.env, c.usdc.clone()]);
    assert_eq!(
        cl.get_balances(&id),
        vec![&c.env, (c.usdc.clone(), PRINCIPAL)]
    );
    assert_eq!(cl.next_id(), 2);

    // ---- accept ----
    c.env.ledger().set_timestamp(START_TS + 10);
    cl.accept(&id);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.trader.clone(),
            auth_root(&c.env, &c.vault, "accept", (id,).into_val(&c.env), std::vec![])
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Activated {
            id,
            start_time: START_TS + 10,
            end_time: START_TS + 10 + DURATION,
        }
        .to_xdr(&c.env, &c.vault)]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Active);
    assert_eq!(ag.start_time, START_TS + 10);
    assert_eq!(ag.end_time, START_TS + 10 + DURATION);
    assert_eq!(cl.value_in_base(&id), PRINCIPAL);

    // ---- trade 200 USDC -> 800 XLM ----
    let amount_in = 200 * UNIT;
    let min_out = 800 * UNIT;
    let deadline = c.now() + 60;
    let out = cl.trade(&id, &c.usdc, &c.xlm, &amount_in, &min_out, &deadline);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.trader.clone(),
            auth_root(
                &c.env,
                &c.vault,
                "trade",
                (id, &c.usdc, &c.xlm, amount_in, min_out, deadline).into_val(&c.env),
                std::vec![],
            )
        )]
    );
    assert_eq!(out, 800 * UNIT);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Traded {
            id,
            trader: c.trader.clone(),
            token_in: c.usdc.clone(),
            token_out: c.xlm.clone(),
            amount_in,
            amount_out: 800 * UNIT,
            value_after: PRINCIPAL, // 800 USDC + 800 XLM @ 0.25
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(
        cl.get_balances(&id),
        vec![
            &c.env,
            (c.usdc.clone(), 800 * UNIT),
            (c.xlm.clone(), 800 * UNIT)
        ]
    );
    assert_eq!(c.bal(&c.usdc, &c.vault), 800 * UNIT);
    assert_eq!(c.bal(&c.xlm, &c.vault), 800 * UNIT);
    assert_eq!(cl.value_in_base(&id), PRINCIPAL);

    // ---- settle by customer (early), zero profit ----
    let min_outs = vec![&c.env, 200 * UNIT];
    cl.settle(&id, &c.customer, &min_outs);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.customer.clone(),
            auth_root(
                &c.env,
                &c.vault,
                "settle",
                (id, &c.customer, min_outs.clone()).into_val(&c.env),
                std::vec![],
            )
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Settled {
            id,
            final_value: PRINCIPAL,
            profit: 0,
            trader_fee: 0,
            platform_fee: 0,
            customer_payout: PRINCIPAL,
            by: c.customer.clone(),
        }
        .to_xdr(&c.env, &c.vault)]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Settled);
    assert_eq!(ag.settled_at, c.now());
    assert_eq!(ag.final_value, PRINCIPAL);
    assert_eq!(ag.customer_payout, PRINCIPAL);
    assert_eq!((ag.trader_fee, ag.platform_fee), (0, 0));
    assert_eq!(c.bal(&c.usdc, &c.customer), PRINCIPAL);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);
    assert_eq!(c.bal(&c.xlm, &c.vault), 0);
    assert_eq!(cl.get_balances(&id), vec![&c.env, (c.usdc.clone(), 0)]);
    assert_eq!(cl.value_in_base(&id), 0);
}

// ===========================================================================
// Lifecycle: trader-initiated (propose -> fund -> trade -> settle w/ profit)
// ===========================================================================

#[test]
fn lifecycle_trader_initiated_with_profit() {
    let c = setup();
    let cl = c.client();
    let terms = c.terms();

    // ---- propose ----
    let id = cl.propose(&c.trader, &terms);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.trader.clone(),
            auth_root(
                &c.env,
                &c.vault,
                "propose",
                (&c.trader, terms.clone()).into_val(&c.env),
                std::vec![],
            )
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Proposed {
            id,
            trader: c.trader.clone(),
            customer: c.customer.clone(),
            principal: PRINCIPAL,
            base_token: c.usdc.clone(),
        }
        .to_xdr(&c.env, &c.vault)]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Proposed);
    assert_eq!(ag.proposer, c.trader);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);
    assert_eq!(cl.get_balances(&id), vec![&c.env, (c.usdc.clone(), 0)]);

    // ---- fund ----
    cl.fund(&id);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.customer.clone(),
            auth_root(
                &c.env,
                &c.vault,
                "fund",
                (id,).into_val(&c.env),
                std::vec![auth_root(
                    &c.env,
                    &c.usdc,
                    "transfer",
                    (&c.customer, &c.vault, PRINCIPAL).into_val(&c.env),
                    std::vec![],
                )],
            )
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Activated {
            id,
            start_time: START_TS,
            end_time: START_TS + DURATION,
        }
        .to_xdr(&c.env, &c.vault)]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Active);
    assert_eq!(c.bal(&c.usdc, &c.vault), PRINCIPAL);

    // ---- trade 200 USDC -> 800 XLM, then XLM doubles ----
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    c.set_price(&c.xlm, &c.usdc, 1, 2); // 800 XLM -> 400 USDC
    assert_eq!(cl.value_in_base(&id), 1_200 * UNIT);

    // ---- settle by trader (early) ----
    let min_outs = vec![&c.env, 400 * UNIT];
    cl.settle(&id, &c.trader, &min_outs);
    assert_eq!(c.env.auths()[0].0, c.trader);
    let final_value = 1_200 * UNIT;
    let profit = 200 * UNIT;
    let trader_fee = 40 * UNIT; // 20%
    let platform_fee = 2 * UNIT; // 1%
    let customer_payout = final_value - trader_fee - platform_fee;
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Settled {
            id,
            final_value,
            profit,
            trader_fee,
            platform_fee,
            customer_payout,
            by: c.trader.clone(),
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(c.bal(&c.usdc, &c.customer), customer_payout);
    assert_eq!(c.bal(&c.usdc, &c.trader), trader_fee);
    assert_eq!(c.bal(&c.usdc, &c.fee_recipient), platform_fee);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Settled);
    assert_eq!(ag.final_value, final_value);
    assert_eq!(ag.trader_fee, trader_fee);
    assert_eq!(ag.platform_fee, platform_fee);
    assert_eq!(ag.customer_payout, customer_payout);
}

// ===========================================================================
// Settlement variants
// ===========================================================================

#[test]
fn settle_with_loss_pays_no_fees() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    c.set_price(&c.xlm, &c.usdc, 1, 8); // XLM halves: 800 XLM -> 100 USDC
    assert_eq!(cl.value_in_base(&id), 900 * UNIT);

    cl.settle(&id, &c.customer, &vec![&c.env, 100 * UNIT]);
    let ag = c.agreement(id);
    assert_eq!(ag.final_value, 900 * UNIT);
    assert_eq!(ag.customer_payout, 900 * UNIT);
    assert_eq!((ag.trader_fee, ag.platform_fee), (0, 0));
    assert_eq!(c.bal(&c.usdc, &c.customer), 900 * UNIT);
    assert_eq!(c.bal(&c.usdc, &c.trader), 0);
    assert_eq!(c.bal(&c.usdc, &c.fee_recipient), 0);
}

#[test]
fn settle_without_trades_returns_principal() {
    let c = setup();
    let cl = c.client();
    let id = c.propose_active();
    cl.settle(&id, &c.customer, &vec![&c.env]);
    assert_eq!(c.bal(&c.usdc, &c.customer), PRINCIPAL);
    assert_eq!(c.agreement(id).status, Status::Settled);
}

#[test]
fn settle_keeper_path_opens_after_grace_with_reference_floor() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    cl.trade(&id, &c.usdc, &c.eurc, &(100 * UNIT), &(90 * UNIT), &(c.now() + 60));
    assert_eq!(c.agreement(id).last_value, PRINCIPAL);
    let end = c.agreement(id).end_time;

    // Before expiry a stranger cannot settle ...
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env]),
        Err(Ok(Error::NotExpired))
    );
    // ... nor inside the grace window reserved for the parties and the admin.
    c.env.ledger().set_timestamp(end);
    assert_eq!(cl.try_trade(&id, &c.usdc, &c.xlm, &UNIT, &1, &(end + 60)), Err(Ok(Error::Expired)));
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env]),
        Err(Ok(Error::NotExpired))
    );
    c.env.ledger().set_timestamp(end + SETTLE_GRACE_SECS - 1);
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env]),
        Err(Ok(Error::NotExpired))
    );

    // Keeper window open. A pool skewed 100x against the vault is what an
    // atomic sandwich looks like from inside the contract: the same-tx quote
    // floor is always met, so the floor must come from `last_value`.
    c.env.ledger().set_timestamp(end + SETTLE_GRACE_SECS);
    c.set_price(&c.xlm, &c.usdc, 1, 400);
    let s = snapshot(&c, id);
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env]),
        Err(Ok(Error::SlippageExceeded))
    );
    assert_unchanged(&c, id, &s);
    // Supplied min_outs are honoured (max with the in-contract floor) ...
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env, 201 * UNIT, 1]),
        Err(Ok(Error::RouterError))
    );
    // ... and must be empty or exactly one non-negative entry per non-base token.
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env, 1]),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        cl.try_settle(&id, &c.stranger, &vec![&c.env, -1, 1]),
        Err(Ok(Error::InvalidAmount))
    );
    assert_unchanged(&c, id, &s);

    // A move inside the tolerance settles: 800 XLM @ 19/80 = 190, so the
    // realised value is 700 + 190 + 100 = 990 = last_value x (1 - 1%).
    c.set_price(&c.xlm, &c.usdc, 19, 80);
    cl.settle(&id, &c.stranger, &vec![&c.env]);
    // auths()/events() describe the most recent invocation: assert first.
    assert!(c.env.auths().is_empty(), "keeper settle must not require auth");
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Settled {
            id,
            final_value: 990 * UNIT,
            profit: 0,
            trader_fee: 0,
            platform_fee: 0,
            customer_payout: 990 * UNIT,
            by: c.stranger.clone(),
        }
        .to_xdr(&c.env, &c.vault)]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Settled);
    assert_eq!(ag.final_value, 990 * UNIT);
    assert_eq!(ag.customer_payout, 990 * UNIT);
    assert_eq!(c.bal(&c.usdc, &c.customer), 990 * UNIT);
    assert_eq!(c.bal(&c.xlm, &c.vault), 0);
    assert_eq!(c.bal(&c.eurc, &c.vault), 0);
}

#[test]
fn settle_by_admin_after_expiry_requires_auth_and_honours_min_outs() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    let end = c.agreement(id).end_time;
    // The admin is not a party: before end_time it is just another stranger.
    assert_eq!(
        cl.try_settle(&id, &c.admin, &vec![&c.env]),
        Err(Ok(Error::NotExpired))
    );
    c.env.ledger().set_timestamp(end);
    // From end_time the admin may settle (no grace) but must sign ...
    c.env.mock_auths(&[]);
    assert!(cl.try_settle(&id, &c.admin, &vec![&c.env]).is_err());
    c.env.mock_all_auths();
    assert_eq!(c.agreement(id).status, Status::Active);
    // ... and its simulated min_outs are enforced, not discarded.
    assert_eq!(
        cl.try_settle(&id, &c.admin, &vec![&c.env, 201 * UNIT]),
        Err(Ok(Error::RouterError))
    );
    assert_eq!(
        cl.try_settle(&id, &c.admin, &vec![&c.env, 1, 1]),
        Err(Ok(Error::InvalidAmount))
    );
    let min_outs = vec![&c.env, 200 * UNIT];
    cl.settle(&id, &c.admin, &min_outs);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.admin.clone(),
            auth_root(
                &c.env,
                &c.vault,
                "settle",
                (id, &c.admin, min_outs.clone()).into_val(&c.env),
                std::vec![],
            )
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Settled {
            id,
            final_value: PRINCIPAL,
            profit: 0,
            trader_fee: 0,
            platform_fee: 0,
            customer_payout: PRINCIPAL,
            by: c.admin.clone(),
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(c.agreement(id).status, Status::Settled);
    assert_eq!(c.bal(&c.usdc, &c.customer), PRINCIPAL);
}

#[test]
fn settle_by_trader_cannot_go_below_drawdown_floor() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active(); // 20% max drawdown -> floor 800 USDC
    cl.trade(&id, &c.usdc, &c.xlm, &(500 * UNIT), &(2_000 * UNIT), &(c.now() + 60));
    // The pool sits 100x against the position (a crash, or the trader
    // skewing it in the same transaction): a trader-signed settle with
    // min_outs = [0] must not realise a value below the agreed floor.
    c.set_price(&c.xlm, &c.usdc, 1, 400); // 2000 XLM -> 5 USDC => 505
    let s = snapshot(&c, id);
    assert_eq!(
        cl.try_settle(&id, &c.trader, &vec![&c.env, 0]),
        Err(Ok(Error::DrawdownBreached))
    );
    assert_unchanged(&c, id, &s);
    // Same after expiry, when `trade` is no longer available to the trader.
    c.env.ledger().set_timestamp(c.agreement(id).end_time + 1);
    assert_eq!(
        cl.try_settle(&id, &c.trader, &vec![&c.env, 0]),
        Err(Ok(Error::DrawdownBreached))
    );
    assert_unchanged(&c, id, &s);
    // Exactly the floor is accepted: 2000 XLM @ 3/20 = 300 => 800.
    c.set_price(&c.xlm, &c.usdc, 3, 20);
    cl.settle(&id, &c.trader, &vec![&c.env, 0]);
    assert_eq!(c.agreement(id).final_value, 800 * UNIT);

    // The customer bears the loss and can always exit, whatever the price.
    c.mint(&c.usdc, &c.customer, PRINCIPAL - 800 * UNIT);
    let id2 = c.open_active();
    cl.trade(&id2, &c.usdc, &c.xlm, &(500 * UNIT), &(2_000 * UNIT), &(c.now() + 60));
    c.set_price(&c.xlm, &c.usdc, 1, 400);
    cl.settle(&id2, &c.customer, &vec![&c.env, 0]);
    assert_eq!(c.agreement(id2).final_value, 505 * UNIT);
    assert_eq!(c.bal(&c.usdc, &c.customer), 505 * UNIT);
}

#[test]
fn settle_post_expiry_by_party_still_uses_their_min_outs() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    c.env.ledger().set_timestamp(c.agreement(id).end_time + 1);
    // party with a too-high min_out -> router refuses
    assert_eq!(
        cl.try_settle(&id, &c.trader, &vec![&c.env, 201 * UNIT]),
        Err(Ok(Error::RouterError))
    );
    cl.settle(&id, &c.trader, &vec![&c.env, 200 * UNIT]);
    assert_eq!(c.env.auths()[0].0, c.trader);
    assert_eq!(c.agreement(id).status, Status::Settled);
}

#[test]
fn settle_validation() {
    let c = setup();
    let cl = c.client();
    // Funded (not Active) -> WrongStatus
    let id = cl.open(&c.customer, &c.terms());
    assert_eq!(
        cl.try_settle(&id, &c.customer, &vec![&c.env]),
        Err(Ok(Error::WrongStatus))
    );
    cl.accept(&id);
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    // min_outs must have one entry per non-base token
    assert_eq!(
        cl.try_settle(&id, &c.customer, &vec![&c.env]),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        cl.try_settle(&id, &c.customer, &vec![&c.env, 1, 1]),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        cl.try_settle(&id, &c.customer, &vec![&c.env, -1]),
        Err(Ok(Error::InvalidAmount))
    );
    // too-high min_out -> the router refuses -> RouterError, state intact
    assert_eq!(
        cl.try_settle(&id, &c.customer, &vec![&c.env, 201 * UNIT]),
        Err(Ok(Error::RouterError))
    );
    assert_eq!(c.agreement(id).status, Status::Active);
    assert_eq!(c.vault_balance(id, &c.xlm), 800 * UNIT);
    // unknown id
    assert_eq!(
        cl.try_settle(&99, &c.customer, &vec![&c.env]),
        Err(Ok(Error::NotFound))
    );
    // success, then a second settle is WrongStatus
    cl.settle(&id, &c.customer, &vec![&c.env, 200 * UNIT]);
    assert_eq!(
        cl.try_settle(&id, &c.customer, &vec![&c.env]),
        Err(Ok(Error::WrongStatus))
    );
}

#[test]
fn fee_leg_that_cannot_be_received_is_folded_into_customer_payout() {
    let c = setup();
    let cl = c.client();
    // A classic account that does not exist in the test ledger: SAC transfers
    // to it fail (no account / no trustline).
    let ghost = Address::from_str(
        &c.env,
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    );
    cl.set_fees(&PLATFORM_FEE_BPS, &ghost);
    let id = c.open_active();
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
    c.set_price(&c.xlm, &c.usdc, 1, 2); // profit 200
    cl.settle(&id, &c.customer, &vec![&c.env, 400 * UNIT]);
    let ag = c.agreement(id);
    assert_eq!(ag.final_value, 1_200 * UNIT);
    assert_eq!(ag.trader_fee, 40 * UNIT);
    assert_eq!(ag.platform_fee, 0, "unreceivable platform fee is not paid");
    assert_eq!(ag.customer_payout, 1_200 * UNIT - 40 * UNIT);
    assert_eq!(c.bal(&c.usdc, &c.customer), 1_160 * UNIT);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);
}

// ===========================================================================
// Pause semantics
// ===========================================================================

#[test]
fn paused_blocks_new_activity_only() {
    let c = setup();
    let cl = c.client();
    let proposed = cl.propose(&c.trader, &c.terms());
    let funded = cl.open(&c.customer, &c.terms());
    c.mint(&c.usdc, &c.customer, 2 * PRINCIPAL);
    let active = c.open_active();
    cl.trade(&active, &c.usdc, &c.xlm, &(100 * UNIT), &(400 * UNIT), &(c.now() + 60));

    cl.set_paused(&true);
    assert_eq!(cl.try_propose(&c.trader, &c.terms()), Err(Ok(Error::Paused)));
    assert_eq!(cl.try_open(&c.customer, &c.terms()), Err(Ok(Error::Paused)));
    assert_eq!(cl.try_fund(&proposed), Err(Ok(Error::Paused)));
    assert_eq!(cl.try_accept(&funded), Err(Ok(Error::Paused)));
    assert_eq!(
        cl.try_trade(&active, &c.usdc, &c.xlm, &UNIT, &1, &(c.now() + 60)),
        Err(Ok(Error::Paused))
    );

    // settle and cancel keep working
    cl.settle(&active, &c.customer, &vec![&c.env, 100 * UNIT]);
    assert_eq!(c.agreement(active).status, Status::Settled);
    cl.cancel(&funded, &c.customer);
    assert_eq!(c.agreement(funded).status, Status::Cancelled);
    cl.cancel(&proposed, &c.trader);
    assert_eq!(c.agreement(proposed).status, Status::Cancelled);
    // 1P minted in setup + 2P minted here - 2 opens + settle payout + refund
    assert_eq!(c.bal(&c.usdc, &c.customer), 3 * PRINCIPAL);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);

    cl.set_paused(&false);
    cl.propose(&c.trader, &c.terms());
}

// ===========================================================================
// Terms & allow-list validation
// ===========================================================================

#[test]
fn invalid_terms_are_rejected() {
    let c = setup();
    let cl = c.client();
    let check = |t: Terms, e: Error| {
        assert_eq!(cl.try_propose(&c.trader, &t), Err(Ok(e)), "{t:?}");
        assert_eq!(cl.try_open(&c.customer, &t), Err(Ok(e)), "{t:?}");
    };
    let mut t = c.terms();
    t.principal = 0;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.principal = -1;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.duration_secs = DAY - 1;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.duration_secs = 3 * 365 * DAY + 1;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.commission_bps = 5_001;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.max_drawdown_bps = 99;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.max_drawdown_bps = 10_001;
    check(t, Error::InvalidTerms);
    let mut t = c.terms();
    t.customer = c.trader.clone();
    // propose: trader == terms.trader ok, but customer == trader -> InvalidTerms
    assert_eq!(cl.try_propose(&c.trader, &t), Err(Ok(Error::InvalidTerms)));
    // non-base token as base
    let mut t = c.terms();
    t.base_token = c.eurc.clone();
    check(t, Error::TokenNotAllowed);
    // unknown token
    let mut t = c.terms();
    t.base_token = Address::generate(&c.env);
    check(t, Error::TokenNotAllowed);
    // boundary values are accepted
    let mut t = c.terms();
    t.duration_secs = DAY;
    t.commission_bps = 5_000;
    t.max_drawdown_bps = 100;
    cl.propose(&c.trader, &t);
    let mut t = c.terms();
    t.duration_secs = 3 * 365 * DAY;
    t.commission_bps = 0;
    t.max_drawdown_bps = 10_000;
    cl.propose(&c.trader, &t);
    // free address argument must match the terms
    assert_eq!(
        cl.try_propose(&c.customer, &c.terms()),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        cl.try_open(&c.trader, &c.terms()),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn token_allow_list_is_enforced() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    let rogue = c.new_token(false, false);
    c.set_price(&c.usdc, &rogue, 1, 1);
    let dl = c.now() + 60;
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &rogue, &UNIT, &1, &dl),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(
        cl.try_trade(&id, &rogue, &c.usdc, &UNIT, &1, &dl),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.usdc, &UNIT, &1, &dl),
        Err(Ok(Error::TokenNotAllowed))
    );
    // de-listing a token mid-flight blocks further trades into it
    cl.set_token(&c.eurc, &false, &false);
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.eurc, &UNIT, &1, &dl),
        Err(Ok(Error::TokenNotAllowed))
    );
    // de-listing the base token blocks new agreements and funding, but the
    // existing active agreement can still settle.
    let proposed = cl.propose(&c.trader, &c.terms());
    cl.set_token(&c.usdc, &false, &false);
    assert_eq!(
        cl.try_open(&c.customer, &c.terms()),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_eq!(cl.try_fund(&proposed), Err(Ok(Error::TokenNotAllowed)));
    cl.settle(&id, &c.customer, &vec![&c.env]);
    assert_eq!(c.agreement(id).status, Status::Settled);
}

#[test]
fn max_tokens_bound_and_slot_reuse() {
    let c = setup();
    let cl = c.client();
    let mut t = c.terms();
    t.max_drawdown_bps = 10_000; // disable drawdown for this test
    let id = cl.open(&c.customer, &t);
    cl.accept(&id);

    let extra: std::vec::Vec<Address> = (0..MAX_TOKENS)
        .map(|_| {
            let tok = c.new_token(true, false);
            c.set_price(&c.usdc, &tok, 1, 1);
            c.set_price(&tok, &c.usdc, 1, 1);
            tok
        })
        .collect();
    let dl = c.now() + 60;
    // base + 5 = MAX_TOKENS
    for tok in extra.iter().take((MAX_TOKENS - 1) as usize) {
        cl.trade(&id, &c.usdc, tok, &(10 * UNIT), &(10 * UNIT), &dl);
    }
    assert_eq!(c.agreement(id).tokens.len(), MAX_TOKENS);
    let sixth = &extra[(MAX_TOKENS - 1) as usize];
    assert_eq!(
        cl.try_trade(&id, &c.usdc, sixth, &(10 * UNIT), &(10 * UNIT), &dl),
        Err(Ok(Error::TooManyTokens))
    );
    // trading into an already-held token is fine
    cl.trade(&id, &c.usdc, &extra[0], &(10 * UNIT), &(10 * UNIT), &dl);
    assert_eq!(c.vault_balance(id, &extra[0]), 20 * UNIT);
    // fully exiting a token frees its slot
    cl.trade(&id, &extra[1], &c.usdc, &(10 * UNIT), &(10 * UNIT), &dl);
    let ag = c.agreement(id);
    assert_eq!(ag.tokens.len(), MAX_TOKENS - 1);
    assert!(!ag.tokens.contains(&extra[1]));
    assert_eq!(ag.tokens.get(0), Some(c.usdc.clone()));
    cl.trade(&id, &c.usdc, sixth, &(10 * UNIT), &(10 * UNIT), &dl);
    assert_eq!(c.agreement(id).tokens.len(), MAX_TOKENS);
    assert_eq!(cl.value_in_base(&id), PRINCIPAL);
    // Settlement quotes and liquidates all of them in order. This is the most
    // expensive invocation the contract can perform (MAX_TOKENS - 1 quotes +
    // swaps, ~30 nested calls); keep it well inside the mainnet per-tx limits
    // (400M instructions / 40MB). Limit *enforcement* is switched off for
    // this one call only because the test harness also meters its debug
    // diagnostics against a "shadow" copy of the same limits, and ~30 nested
    // calls under `DiagnosticLevel::Debug` exceed that shadow memory budget;
    // the shadow budget never affects fees or outcomes on a network. The real
    // resources are still measured and asserted below.
    let min_outs: Vec<i128> = vec![&c.env, 20 * UNIT, 10 * UNIT, 10 * UNIT, 10 * UNIT, 10 * UNIT];
    c.env.cost_estimate().disable_resource_limits();
    cl.settle(&id, &c.customer, &min_outs);
    let r = c.env.cost_estimate().resources();
    assert!(r.instructions < 400_000_000 / 10, "settle cpu {}", r.instructions);
    assert!(r.mem_bytes < 41_943_040 / 10, "settle mem {}", r.mem_bytes);
    assert_eq!(c.bal(&c.usdc, &c.customer), PRINCIPAL);
    for tok in &extra {
        assert_eq!(c.bal(tok, &c.vault), 0);
    }
}

// ===========================================================================
// Trade failure modes (all must roll back completely)
// ===========================================================================

struct Snapshot {
    ag: Agreement,
    balances: Vec<(Address, i128)>,
    vault_usdc: i128,
    vault_xlm: i128,
    router_usdc: i128,
    router_xlm: i128,
}

fn snapshot(c: &Ctx, id: u64) -> Snapshot {
    Snapshot {
        ag: c.agreement(id),
        balances: c.client().get_balances(&id),
        vault_usdc: c.bal(&c.usdc, &c.vault),
        vault_xlm: c.bal(&c.xlm, &c.vault),
        router_usdc: c.bal(&c.usdc, &c.router),
        router_xlm: c.bal(&c.xlm, &c.router),
    }
}

fn assert_unchanged(c: &Ctx, id: u64, s: &Snapshot) {
    assert_eq!(c.agreement(id), s.ag);
    assert_eq!(c.client().get_balances(&id), s.balances);
    assert_eq!(c.bal(&c.usdc, &c.vault), s.vault_usdc);
    assert_eq!(c.bal(&c.xlm, &c.vault), s.vault_xlm);
    assert_eq!(c.bal(&c.usdc, &c.router), s.router_usdc);
    assert_eq!(c.bal(&c.xlm, &c.router), s.router_xlm);
}

#[test]
fn trade_router_slippage_failure_rolls_back() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    let s = snapshot(&c, id);
    // 200 USDC quotes 800 XLM; asking for 801 makes the (strict) router fail.
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT + 1), &(c.now() + 60)),
        Err(Ok(Error::RouterError))
    );
    assert_unchanged(&c, id, &s);
}

#[test]
fn trade_recheck_catches_router_that_ignores_min_out() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active();
    c.router().set_strict(&false); // router now ignores amount_out_min
    let s = snapshot(&c, id);
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT + 1), &(c.now() + 60)),
        Err(Ok(Error::SlippageExceeded))
    );
    assert_unchanged(&c, id, &s);
    // exact min_out still passes the vault's own check
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &(c.now() + 60));
}

#[test]
fn trade_drawdown_breach_rolls_back() {
    let c = setup();
    let cl = c.client();
    let id = c.open_active(); // max drawdown 20% -> floor 800 USDC
    // Router sells XLM at 4/USDC but only buys back at 8/USDC (50% haircut).
    c.set_price(&c.xlm, &c.usdc, 1, 8);
    let dl = c.now() + 60;
    let s = snapshot(&c, id);
    // 500 USDC -> 2000 XLM worth 250 => value 750 < 800
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &(500 * UNIT), &(2_000 * UNIT), &dl),
        Err(Ok(Error::DrawdownBreached))
    );
    assert_unchanged(&c, id, &s);
    // 400 USDC -> 1600 XLM worth 200 => value 800 == floor: allowed
    cl.trade(&id, &c.usdc, &c.xlm, &(400 * UNIT), &(1_600 * UNIT), &dl);
    assert_eq!(cl.value_in_base(&id), 800 * UNIT);
    // any further loss-making trade breaches
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &UNIT, &(4 * UNIT), &dl),
        Err(Ok(Error::DrawdownBreached))
    );
    // a trade that improves value (XLM back to USDC at 1/8) is fine
    cl.trade(&id, &c.xlm, &c.usdc, &(800 * UNIT), &(100 * UNIT), &dl);
    assert_eq!(cl.value_in_base(&id), 800 * UNIT);
}

#[test]
fn trade_rejects_token_without_route_back_to_base() {
    let c = setup();
    let cl = c.client();
    let mut t = c.terms();
    t.max_drawdown_bps = 10_000; // even with the drawdown check disabled
    let id = cl.open(&c.customer, &t);
    cl.accept(&id);
    let dl = c.now() + 60;
    // Direct buy of a token with no `[token, base]` route.
    let oneway = c.new_token(true, false);
    c.set_price(&c.usdc, &oneway, 1, 1);
    let s = snapshot(&c, id);
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &oneway, &(300 * UNIT), &(300 * UNIT), &dl),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_unchanged(&c, id, &s);
    // Two-hop parking: USDC -> XLM is fine, XLM -> iso is not while iso has
    // no route back to USDC (the testnet shape: XLM-centric pools only).
    let iso = c.new_token(true, false);
    c.set_price(&c.xlm, &iso, 1, 1);
    c.set_price(&iso, &c.xlm, 1, 1);
    cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &dl);
    let s = snapshot(&c, id);
    assert_eq!(
        cl.try_trade(&id, &c.xlm, &iso, &(800 * UNIT), &(800 * UNIT), &dl),
        Err(Ok(Error::TokenNotAllowed))
    );
    assert_unchanged(&c, id, &s);
    // Once a route exists the same trade goes through ...
    c.set_price(&iso, &c.usdc, 1, 4);
    cl.trade(&id, &c.xlm, &iso, &(800 * UNIT), &(800 * UNIT), &dl);
    assert_eq!(c.vault_balance(id, &iso), 800 * UNIT);
    assert_eq!(cl.value_in_base(&id), PRINCIPAL);
    // ... and selling back into the base token never needs a quote.
    cl.trade(&id, &iso, &c.usdc, &(800 * UNIT), &(200 * UNIT), &dl);
    assert_eq!(cl.value_in_base(&id), PRINCIPAL);
    assert_eq!(c.agreement(id).tokens, vec![&c.env, c.usdc.clone()]);
}

#[test]
fn trade_input_validation() {
    let c = setup();
    let cl = c.client();
    let funded = cl.open(&c.customer, &c.terms());
    c.mint(&c.usdc, &c.customer, PRINCIPAL);
    let id = c.open_active();
    let dl = c.now() + 60;
    assert_eq!(
        cl.try_trade(&funded, &c.usdc, &c.xlm, &UNIT, &1, &dl),
        Err(Ok(Error::WrongStatus))
    );
    assert_eq!(
        cl.try_trade(&99, &c.usdc, &c.xlm, &UNIT, &1, &dl),
        Err(Ok(Error::NotFound))
    );
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &0, &1, &dl),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &-5, &1, &dl),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &UNIT, &0, &dl),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &(PRINCIPAL + 1), &1, &dl),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(
        cl.try_trade(&id, &c.xlm, &c.usdc, &UNIT, &1, &dl),
        Err(Ok(Error::InsufficientBalance))
    );
    // stale deadline
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &UNIT, &1, &(c.now() - 1)),
        Err(Ok(Error::Expired))
    );
    // at/after end_time
    c.env.ledger().set_timestamp(c.agreement(id).end_time);
    assert_eq!(
        cl.try_trade(&id, &c.usdc, &c.xlm, &UNIT, &1, &(c.now() + 60)),
        Err(Ok(Error::Expired))
    );
}

// ===========================================================================
// Authorization negatives (wrong signer for every mutating fn)
// ===========================================================================

#[test]
fn lifecycle_functions_reject_wrong_signer() {
    let c = setup();
    let cl = c.client();
    let terms = c.terms();
    let proposed = cl.propose(&c.trader, &terms);
    let funded = cl.open(&c.customer, &terms);
    c.mint(&c.usdc, &c.customer, PRINCIPAL);
    let active = c.open_active();
    let dl = c.now() + 60;

    // Only `signer` authorises `f(args)`; nothing else is mocked.
    let sign = |signer: &Address, f: &'static str, args: Vec<soroban_sdk::Val>| {
        c.env.mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &c.vault,
                fn_name: f,
                args,
                sub_invokes: &[],
            },
        }]);
    };

    sign(&c.stranger, "propose", (&c.trader, terms.clone()).into_val(&c.env));
    assert!(cl.try_propose(&c.trader, &terms).is_err());
    sign(&c.stranger, "open", (&c.customer, terms.clone()).into_val(&c.env));
    assert!(cl.try_open(&c.customer, &terms).is_err());
    sign(&c.trader, "fund", (proposed,).into_val(&c.env));
    assert!(cl.try_fund(&proposed).is_err());
    sign(&c.customer, "accept", (funded,).into_val(&c.env));
    assert!(cl.try_accept(&funded).is_err());
    sign(&c.trader, "cancel", (funded, &c.customer).into_val(&c.env));
    assert!(cl.try_cancel(&funded, &c.customer).is_err());
    sign(
        &c.customer,
        "trade",
        (active, &c.usdc, &c.xlm, UNIT, 1i128, dl).into_val(&c.env),
    );
    assert!(cl
        .try_trade(&active, &c.usdc, &c.xlm, &UNIT, &1, &dl)
        .is_err());
    let empty: Vec<i128> = vec![&c.env];
    sign(&c.trader, "settle", (active, &c.customer, empty.clone()).into_val(&c.env));
    assert!(cl.try_settle(&active, &c.customer, &empty).is_err());
    sign(&c.stranger, "claim", (active, &c.usdc).into_val(&c.env));
    assert!(cl.try_claim(&active, &c.usdc).is_err());
    // no auth at all
    c.env.mock_auths(&[]);
    assert!(cl.try_fund(&proposed).is_err());
    assert!(cl.try_accept(&funded).is_err());
    assert!(cl.try_settle(&active, &c.trader, &empty).is_err());

    // state untouched
    c.env.mock_all_auths();
    assert_eq!(c.agreement(proposed).status, Status::Proposed);
    assert_eq!(c.agreement(funded).status, Status::Funded);
    assert_eq!(c.agreement(active).status, Status::Active);
    assert_eq!(c.vault_balance(active, &c.usdc), PRINCIPAL);
}

// ===========================================================================
// Cancel / refund
// ===========================================================================

#[test]
fn cancel_proposed_only_by_proposer() {
    let c = setup();
    let cl = c.client();
    let id = cl.propose(&c.trader, &c.terms());
    assert_eq!(cl.try_cancel(&id, &c.customer), Err(Ok(Error::NotParty)));
    assert_eq!(cl.try_cancel(&id, &c.stranger), Err(Ok(Error::NotParty)));
    cl.cancel(&id, &c.trader);
    assert_eq!(c.env.auths()[0].0, c.trader);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Cancelled { id, refunded: 0 }.to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(c.agreement(id).status, Status::Cancelled);
    assert_eq!(cl.try_fund(&id), Err(Ok(Error::WrongStatus)));
    assert_eq!(cl.try_cancel(&id, &c.trader), Err(Ok(Error::WrongStatus)));
}

#[test]
fn cancel_funded_refunds_customer() {
    let c = setup();
    let cl = c.client();
    // by customer
    let id = cl.open(&c.customer, &c.terms());
    assert_eq!(c.bal(&c.usdc, &c.customer), 0);
    assert_eq!(cl.try_cancel(&id, &c.stranger), Err(Ok(Error::NotParty)));
    cl.cancel(&id, &c.customer);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Cancelled {
            id,
            refunded: PRINCIPAL
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(c.bal(&c.usdc, &c.customer), PRINCIPAL);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);
    assert_eq!(c.agreement(id).status, Status::Cancelled);
    assert_eq!(cl.get_balances(&id), vec![&c.env, (c.usdc.clone(), 0)]);
    assert_eq!(cl.try_accept(&id), Err(Ok(Error::WrongStatus)));

    // by trader (rejecting the offer)
    let id2 = cl.open(&c.customer, &c.terms());
    cl.cancel(&id2, &c.trader);
    assert_eq!(c.bal(&c.usdc, &c.customer), PRINCIPAL);
    assert_eq!(c.agreement(id2).status, Status::Cancelled);

    // Active agreements cannot be cancelled (use settle)
    let id3 = c.open_active();
    assert_eq!(cl.try_cancel(&id3, &c.customer), Err(Ok(Error::WrongStatus)));
}

// ===========================================================================
// TTL, views, valuation
// ===========================================================================

#[test]
fn ttl_is_extended_on_writes() {
    let c = setup();
    let id = c.open_active();
    let (ag_ttl, bal_ttl, inst_ttl) = c.env.as_contract(&c.vault, || {
        (
            c.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Agreement(id)),
            c.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Balance(id, c.usdc.clone())),
            c.env.storage().instance().get_ttl(),
        )
    });
    assert!(ag_ttl >= TTL_EXTEND_TO - 1, "agreement ttl {ag_ttl}");
    assert!(bal_ttl >= TTL_EXTEND_TO - 1, "balance ttl {bal_ttl}");
    assert!(inst_ttl >= TTL_EXTEND_TO - 1, "instance ttl {inst_ttl}");
}

#[test]
fn views_on_missing_agreement() {
    let c = setup();
    let cl = c.client();
    assert_eq!(cl.try_get_agreement(&7), Err(Ok(Error::NotFound)));
    assert_eq!(cl.try_get_balances(&7), Err(Ok(Error::NotFound)));
    assert_eq!(cl.try_value_in_base(&7), Err(Ok(Error::NotFound)));
    assert_eq!(cl.try_accept(&7), Err(Ok(Error::NotFound)));
    assert_eq!(cl.try_fund(&7), Err(Ok(Error::NotFound)));
    assert_eq!(cl.try_cancel(&7, &c.customer), Err(Ok(Error::NotFound)));
}

#[test]
fn value_in_base_counts_unquotable_token_as_zero() {
    let c = setup();
    let cl = c.client();
    let mut t = c.terms();
    t.max_drawdown_bps = 10_000;
    let id = cl.open(&c.customer, &t);
    cl.accept(&id);
    let weird = c.new_token(true, false);
    c.set_price(&c.usdc, &weird, 1, 1);
    c.set_price(&weird, &c.usdc, 1, 1);
    cl.trade(&id, &c.usdc, &weird, &(300 * UNIT), &(300 * UNIT), &(c.now() + 60));
    assert_eq!(c.vault_balance(id, &weird), 300 * UNIT);
    assert_eq!(cl.value_in_base(&id), PRINCIPAL);
    // The pool disappears: the holding is worth 0 to the drawdown check ...
    c.clear_price(&weird, &c.usdc);
    assert_eq!(cl.value_in_base(&id), 700 * UNIT);
    // ... and cannot be sold at settlement, so it is delivered in kind
    // instead of locking the whole principal (any min_out, even a high one).
    cl.settle(&id, &c.customer, &vec![&c.env, 300 * UNIT]);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![
            Unliquidated {
                id,
                token: weird.clone(),
                amount: 300 * UNIT,
                delivered: true,
            }
            .to_xdr(&c.env, &c.vault),
            Settled {
                id,
                final_value: 700 * UNIT,
                profit: 0,
                trader_fee: 0,
                platform_fee: 0,
                customer_payout: 700 * UNIT,
                by: c.customer.clone(),
            }
            .to_xdr(&c.env, &c.vault),
        ]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Settled);
    assert_eq!(ag.final_value, 700 * UNIT);
    assert_eq!(ag.tokens, vec![&c.env, c.usdc.clone()]);
    assert_eq!(c.bal(&c.usdc, &c.customer), 700 * UNIT);
    assert_eq!(c.bal(&weird, &c.customer), 300 * UNIT);
    assert_eq!(c.bal(&weird, &c.vault), 0);
    assert_eq!(cl.value_in_base(&id), 0);
}

#[test]
fn settle_delivers_unquotable_dust_in_kind_on_every_path() {
    let c = setup();
    let cl = c.client();
    c.mint(&c.usdc, &c.customer, 2 * PRINCIPAL);
    let dl = c.now() + 60;
    // Three agreements, each left with 1 stroop of XLM, which quotes to
    // 0 USDC: without in-kind delivery every settle path would fail
    // (0 output -> SlippageExceeded / router refusal) and freeze ~1000 USDC.
    let ids: std::vec::Vec<u64> = (0..3)
        .map(|_| {
            let id = c.open_active();
            cl.trade(&id, &c.usdc, &c.xlm, &(200 * UNIT), &(800 * UNIT), &dl);
            cl.trade(&id, &c.xlm, &c.usdc, &(800 * UNIT - 1), &1, &dl);
            assert_eq!(c.vault_balance(id, &c.xlm), 1);
            assert_eq!(c.agreement(id).tokens.len(), 2);
            assert_eq!(cl.value_in_base(&id), PRINCIPAL - 1);
            id
        })
        .collect();
    let assert_dust_settled = |id: u64, by: &Address| {
        assert_eq!(
            c.env.events().all().filter_by_contract(&c.vault),
            std::vec![
                Unliquidated {
                    id,
                    token: c.xlm.clone(),
                    amount: 1,
                    delivered: true,
                }
                .to_xdr(&c.env, &c.vault),
                Settled {
                    id,
                    final_value: PRINCIPAL - 1,
                    profit: 0,
                    trader_fee: 0,
                    platform_fee: 0,
                    customer_payout: PRINCIPAL - 1,
                    by: by.clone(),
                }
                .to_xdr(&c.env, &c.vault),
            ]
        );
        let ag = c.agreement(id);
        assert_eq!(ag.status, Status::Settled);
        assert_eq!(ag.tokens, vec![&c.env, c.usdc.clone()]);
        assert_eq!(cl.get_balances(&id), vec![&c.env, (c.usdc.clone(), 0)]);
    };
    // customer, any time
    cl.settle(&ids[0], &c.customer, &vec![&c.env, 0]);
    assert_dust_settled(ids[0], &c.customer);
    // trader, any time (PRINCIPAL - 1 is above the drawdown floor)
    cl.settle(&ids[1], &c.trader, &vec![&c.env, 1]);
    assert_dust_settled(ids[1], &c.trader);
    // keeper, after the grace window (PRINCIPAL - 1 >= last_value x 99%)
    c.env.ledger().set_timestamp(c.agreement(ids[2]).end_time + SETTLE_GRACE_SECS);
    cl.settle(&ids[2], &c.stranger, &vec![&c.env]);
    assert!(c.env.auths().is_empty());
    assert_dust_settled(ids[2], &c.stranger);
    assert_eq!(c.bal(&c.xlm, &c.customer), 3);
    assert_eq!(c.bal(&c.usdc, &c.customer), 3 * (PRINCIPAL - 1));
    assert_eq!(c.bal(&c.xlm, &c.vault), 0);
    assert_eq!(c.bal(&c.usdc, &c.vault), 0);
}

#[test]
fn settle_orphans_unreceivable_in_kind_leg_until_claimed() {
    let c = setup();
    let cl = c.client();
    let mut t = c.terms();
    t.max_drawdown_bps = 10_000;
    let id = cl.open(&c.customer, &t);
    cl.accept(&id);
    let weird = c.new_revocable_token();
    c.set_price(&c.usdc, &weird, 1, 1);
    c.set_price(&weird, &c.usdc, 1, 1);
    cl.trade(&id, &c.usdc, &weird, &(300 * UNIT), &(300 * UNIT), &(c.now() + 60));
    c.clear_price(&weird, &c.usdc);
    // The customer cannot receive `weird`: the leg is kept, not lost, and
    // the rest of the settlement goes through.
    c.set_authorized(&weird, &c.customer, false);
    cl.settle(&id, &c.customer, &vec![&c.env, 0]);
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![
            Unliquidated {
                id,
                token: weird.clone(),
                amount: 300 * UNIT,
                delivered: false,
            }
            .to_xdr(&c.env, &c.vault),
            Settled {
                id,
                final_value: 700 * UNIT,
                profit: 0,
                trader_fee: 0,
                platform_fee: 0,
                customer_payout: 700 * UNIT,
                by: c.customer.clone(),
            }
            .to_xdr(&c.env, &c.vault),
        ]
    );
    let ag = c.agreement(id);
    assert_eq!(ag.status, Status::Settled);
    assert_eq!(ag.tokens, vec![&c.env, c.usdc.clone(), weird.clone()]);
    assert_eq!(
        cl.get_balances(&id),
        vec![&c.env, (c.usdc.clone(), 0), (weird.clone(), 300 * UNIT)]
    );
    assert_eq!(c.bal(&weird, &c.vault), 300 * UNIT);
    assert_eq!(c.bal(&c.usdc, &c.customer), 700 * UNIT);

    // Still unreceivable: claim fails and nothing moves.
    assert!(cl.try_claim(&id, &weird).is_err());
    assert_eq!(c.vault_balance(id, &weird), 300 * UNIT);
    // Nothing to claim for other tokens.
    assert_eq!(cl.try_claim(&id, &c.usdc), Err(Ok(Error::InsufficientBalance)));
    // Only the customer may claim.
    c.env.mock_auths(&[MockAuth {
        address: &c.stranger,
        invoke: &MockAuthInvoke {
            contract: &c.vault,
            fn_name: "claim",
            args: (id, &weird).into_val(&c.env),
            sub_invokes: &[],
        },
    }]);
    assert!(cl.try_claim(&id, &weird).is_err());
    c.env.mock_all_auths();

    // Once receivable, the customer collects it.
    c.set_authorized(&weird, &c.customer, true);
    assert_eq!(cl.claim(&id, &weird), 300 * UNIT);
    assert_eq!(
        c.env.auths(),
        std::vec![(
            c.customer.clone(),
            auth_root(&c.env, &c.vault, "claim", (id, &weird).into_val(&c.env), std::vec![])
        )]
    );
    assert_eq!(
        c.env.events().all().filter_by_contract(&c.vault),
        std::vec![Claimed {
            id,
            token: weird.clone(),
            amount: 300 * UNIT,
        }
        .to_xdr(&c.env, &c.vault)]
    );
    assert_eq!(c.bal(&weird, &c.customer), 300 * UNIT);
    assert_eq!(c.bal(&weird, &c.vault), 0);
    assert_eq!(c.agreement(id).tokens, vec![&c.env, c.usdc.clone()]);
    assert_eq!(cl.try_claim(&id, &weird), Err(Ok(Error::InsufficientBalance)));
    // claim is for settled agreements only
    c.mint(&c.usdc, &c.customer, PRINCIPAL);
    let active = c.open_active();
    assert_eq!(cl.try_claim(&active, &c.usdc), Err(Ok(Error::WrongStatus)));
}

#[test]
fn ids_are_sequential_across_propose_and_open() {
    let c = setup();
    let cl = c.client();
    c.mint(&c.usdc, &c.customer, PRINCIPAL);
    assert_eq!(cl.next_id(), 1);
    assert_eq!(cl.propose(&c.trader, &c.terms()), 1);
    assert_eq!(cl.open(&c.customer, &c.terms()), 2);
    assert_eq!(cl.propose(&c.trader, &c.terms()), 3);
    assert_eq!(cl.next_id(), 4);
    // a failed creation does not consume an id
    let mut bad = c.terms();
    bad.principal = 0;
    assert!(cl.try_propose(&c.trader, &bad).is_err());
    assert_eq!(cl.next_id(), 4);
}

// ===========================================================================
// Settlement math invariants (fuzz-style, deterministic LCG)
// ===========================================================================

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn range_i128(&mut self, lo: i128, hi: i128) -> i128 {
        // 106 random bits (non-negative), so ranges wider than 2^53 are
        // actually covered instead of silently capped at ~9e15.
        let r = (((self.next() as u128) << 53) | self.next() as u128) as i128;
        lo + r % (hi - lo + 1)
    }
    fn range_u32(&mut self, lo: u32, hi: u32) -> u32 {
        lo + (self.next() as u32) % (hi - lo + 1)
    }
}

#[test]
fn settlement_math_invariants() {
    let mut rng = Lcg(0x5eed_1234_abcd_0001);
    let huge: i128 = i128::from(u64::MAX) * 1_000; // ~1.8e22
    let mut max_seen: i128 = 0;
    for i in 0..20_000 {
        // mix tiny, realistic and huge magnitudes
        let scale: i128 = match i % 4 {
            0 => 1_000,
            1 => 1_000_000 * UNIT,
            2 => 1_000_000_000_000 * UNIT,
            _ => huge, // products stay < 1e27, far from i128::MAX (1.7e38)
        };
        let principal = rng.range_i128(1, scale);
        let final_value = rng.range_i128(0, scale * 2);
        max_seen = max_seen.max(final_value);
        let commission_bps = rng.range_u32(0, 5_000);
        let platform_fee_bps = rng.range_u32(0, 1_000);

        let s = math::settlement(final_value, principal, commission_bps, platform_fee_bps)
            .expect("settlement math must not fail on valid inputs");
        let expected_profit = if final_value > principal {
            final_value - principal
        } else {
            0
        };
        assert_eq!(s.profit, expected_profit);
        assert_eq!(
            s.customer_payout + s.trader_fee + s.platform_fee,
            final_value,
            "payout + fees must equal final value"
        );
        assert!(s.trader_fee + s.platform_fee <= s.profit, "fees exceed profit");
        assert!(s.trader_fee >= 0 && s.platform_fee >= 0 && s.customer_payout >= 0);
        assert_eq!(s.trader_fee, expected_profit * commission_bps as i128 / 10_000);
        assert_eq!(s.platform_fee, expected_profit * platform_fee_bps as i128 / 10_000);
        if final_value <= principal {
            assert_eq!(s.customer_payout, final_value, "loss: customer gets everything");
        } else {
            assert!(s.customer_payout >= principal, "profit case never dips below principal");
        }
    }
    // negative inputs are rejected, not silently accepted
    assert_eq!(math::settlement(-1, 1, 0, 0), Err(Error::InvalidAmount));
    assert_eq!(math::settlement(1, -1, 0, 0), Err(Error::InvalidAmount));
    // the huge bucket really was sampled (guards against a capped generator)
    assert!(max_seen > huge, "generator never reached the huge bucket: {max_seen}");
    // overflow surfaces as a typed error, never a panic
    assert_eq!(math::bps_of(i128::MAX, 2), Err(Error::Overflow));
    assert_eq!(
        math::settlement(i128::MAX / 2, 1, 5_000, 1_000),
        Err(Error::Overflow)
    );
}

#[test]
fn drawdown_and_slippage_math() {
    assert_eq!(math::drawdown_floor(PRINCIPAL, 2_000), Ok(800 * UNIT));
    assert_eq!(math::drawdown_floor(PRINCIPAL, 10_000), Ok(0));
    assert_eq!(math::drawdown_floor(PRINCIPAL, 100), Ok(990 * UNIT));
    assert_eq!(math::drawdown_floor(PRINCIPAL, 10_001), Err(Error::InvalidTerms));
    assert_eq!(math::min_out_with_slippage(1_000, 100), Ok(990));
    assert_eq!(math::min_out_with_slippage(1_000, 0), Ok(1_000));
    assert_eq!(math::min_out_with_slippage(0, 500), Ok(0));
    // floor rounding
    assert_eq!(math::bps_of(999, 2_500), Ok(249));
    let mut rng = Lcg(42);
    for _ in 0..5_000 {
        let p = rng.range_i128(1, 1_000_000_000 * UNIT);
        let bps = rng.range_u32(100, 10_000);
        let floor = math::drawdown_floor(p, bps).unwrap();
        assert!(floor >= 0 && floor <= p);
        // monotonic: a larger allowed drawdown never raises the floor
        if bps < 10_000 {
            assert!(math::drawdown_floor(p, bps + 1).unwrap() <= floor);
        }
    }
}
