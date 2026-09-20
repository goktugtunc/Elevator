# TraderKirala Vault — Contract Interface Reference

Contract crate: `contracts/vault` (`traderkirala_vault`, soroban-sdk 28, protocol 28,
`contractmeta binver = 1.1.0`). Mock router for tests/testnet: `contracts/mock_router`.
This document is the reference for the backend (`app/services/contract_abi.py`,
`soroban.py`, `indexer.py`) and the mobile signing flow. The binding spec is
`docs/DESIGN.md §1` (plus the review amendments in §1.9); deviations are listed at the end.

Build: `cd contracts && stellar contract build` → `target/wasm32v1-none/release/traderkirala_vault.wasm`
(≈31 KB). Tests: `cargo test` (40 tests: 37 vault + 3 mock router).

---

## 1. State machine

```
                 propose(trader, terms)                 open(customer, terms)
                 [trader auth, no funds]                [customer auth, principal escrowed]
                          │                                        │
                          ▼                                        ▼
                    ┌──────────┐                             ┌──────────┐
                    │ Proposed │                             │  Funded  │
                    └────┬─────┘                             └────┬─────┘
       cancel(id,proposer)│  fund(id)                 accept(id)  │ cancel(id, customer|trader)
       refunded = 0       │  [customer auth,          [trader auth]│ refunds principal
            ▼             │   principal escrowed]          │       ▼
      ┌───────────┐       ▼                                ▼   ┌───────────┐
      │ Cancelled │   ┌────────────────────────────────────────┐│ Cancelled │
      └───────────┘   │                 Active                 │└───────────┘
                      │  start_time = now, end_time = now+dur  │
                      │  trade(...)  [trader auth, now<end]    │
                      └───────────────────┬────────────────────┘
                                          │ settle(id, caller, min_outs)
                                          │  customer | trader : any time, auth, own min_outs
                                          │  admin             : now >= end_time, auth, min_outs honoured
                                          │  anyone else       : now >= end_time + 7 d, no auth,
                                          │                      reference floor (last_value)
                                          ▼
                                    ┌───────────┐  payouts transferred, balances zeroed;
                                    │  Settled  │  an in-kind leg the customer could not
                                    └─────┬─────┘  receive stays claimable
                                          │ claim(id, token)  [customer auth]
                                          ▼
                                     (same status)
```

`paused = true` blocks `propose / open / fund / accept / trade` only. `cancel`, `settle` and
`claim` always work, so the admin can never lock user funds.

Numeric status codes (`Status` enum, u32): `Proposed=0, Funded=1, Active=2, Settled=3, Cancelled=4`.

---

## 2. Types

```rust
struct Terms {
    customer: Address, trader: Address, base_token: Address,
    principal: i128,          // raw units (7 dp for SACs), > 0
    duration_secs: u64,       // 86_400 (1 day) ..= 94_608_000 (3 years)
    commission_bps: u32,      // 0 ..= 5_000   (trader's share of positive profit)
    max_drawdown_bps: u32,    // 100 ..= 10_000 (10_000 = check disabled)
    listing_ref: BytesN<32>,  // sha256 of the off-chain listing/offer id
}
struct Agreement {
    id: u64, terms: Terms, status: Status,
    proposer: Address,                          // customer (open) or trader (propose)
    created_at: u64, start_time: u64, end_time: u64,   // start/end are 0 until Active
    tokens: Vec<Address>,                       // currently held; base_token always first; len <= 6
                                                // after settlement: [base] + in-kind legs still claimable
    settled_at: u64, final_value: i128, trader_fee: i128, platform_fee: i128, customer_payout: i128,
    last_value: i128,                           // principal at creation, then value_after of every
                                                // trade, then final_value at settlement (see §3.3)
}
struct Config { admin, router, platform_fee_bps: u32, fee_recipient, paused: bool, settle_slippage_bps: u32 }
struct TokenInfo { allowed: bool, is_base: bool }
enum DataKey { Config, NextId, Agreement(u64), Balance(u64, Address), AllowedToken(Address) }
```

Constants: `MAX_TOKENS = 6`, `MIN_DURATION = 1 day`, `MAX_DURATION = 3 years`,
`MAX_COMMISSION_BPS = 5000`, `MAX_PLATFORM_FEE_BPS = 1000`, `MIN_DRAWDOWN_BPS = 100`,
`MAX_SETTLE_SLIPPAGE_BPS = 5000`, `SETTLE_GRACE_SECS = 7 days`. Agreement ids start at **1** and
are sequential across `propose` and `open` (a failed creation does not consume an id).

Storage: `Config`, `NextId` and the token allow-list live in **instance** storage (TTL
bumped 30d→120d at the start of every mutating call); `Agreement(id)` and
`Balance(id, token)` are **persistent** entries, TTL bumped 30d→120d on every write.
Balance entries are removed (not zeroed) when a token is fully exited or on settle/cancel/claim;
a missing entry reads as 0. The only balance that can outlive a settlement is an in-kind leg the
customer could not receive (§3.3), which `claim` removes.

---

## 3. Functions

All functions return `Result<_, Error>`; on error the whole invocation (including
router/token side effects) is rolled back.

### Constructor
| fn | args | notes |
|---|---|---|
| `__constructor` | `admin, router, fee_recipient, platform_fee_bps: u32, settle_slippage_bps: u32` | `platform_fee_bps <= 1000`, `settle_slippage_bps <= 5000` else `InvalidTerms`. Sets `paused=false`, `NextId=1`. |

### Admin (auth: `config.admin`, loaded from storage)
| fn | args | effect / errors | event |
|---|---|---|---|
| `set_token` | `token, allowed: bool, is_base: bool` | allow-list entry; `allowed=false` also clears `is_base` | `TokenSet` |
| `set_router` | `router` | replaces the AMM router used for quotes & swaps | `ConfigChanged{key:"router"}` |
| `set_fees` | `platform_fee_bps, fee_recipient` | `bps <= 1000` else `InvalidTerms` | `ConfigChanged{key:"fees"}` |
| `set_paused` | `paused: bool` | see §1 | `ConfigChanged{key:"paused"}` |
| `set_settle_slippage` | `bps: u32` | `bps <= 5000` else `InvalidTerms`; tolerance of the keeper path (§3.3) | `ConfigChanged{key:"slippage"}` |
| `upgrade` | `wasm_hash: BytesN<32>` | `update_current_contract(Wasm(hash))`; storage untouched, constructor does not re-run | `Upgraded` |

### Lifecycle
| fn | args → returns | auth | rules / errors | event |
|---|---|---|---|---|
| `propose` | `trader, terms → id` | `trader` (must equal `terms.trader`, else `Unauthorized`) | `Paused`; terms validation (§3.1) | `Proposed` |
| `open` | `customer, terms → id` | `customer` (= `terms.customer`) **+ inner** `base_token.transfer(customer, vault, principal)` | `Paused`; validation; escrows principal → `Funded` | `Opened` |
| `fund` | `id` | `terms.customer` (from storage) **+ inner** `transfer(customer, vault, principal)` | `NotFound`, `Paused`, `WrongStatus` (not Proposed), `TokenNotAllowed` (base de-listed since); sets start/end → `Active` | `Activated` |
| `accept` | `id` | `terms.trader` | `NotFound`, `Paused`, `WrongStatus` (not Funded) → `Active` | `Activated` |
| `cancel` | `id, caller` | `caller` | Proposed: `caller == proposer`; Funded: `caller ∈ {customer, trader}` (refunds principal to customer); else `NotParty` / `WrongStatus`. Works while paused. | `Cancelled{refunded}` |
| `trade` | `id, token_in, token_out, amount_in, min_out, deadline → amount_out` | `terms.trader` | see §3.2 | `Traded` |
| `settle` | `id, caller, min_outs: Vec<i128>` | party or admin caller: `caller.require_auth()`; other callers: none | see §3.3. Works while paused. | `Settled` (+ `Unliquidated` per in-kind leg) |
| `claim` | `id, token → amount` | `terms.customer` | `WrongStatus` unless Settled; `InsufficientBalance` if nothing is held; transfers the whole held balance of `token` to the customer and drops it from `tokens`. Works while paused. | `Claimed` |

### Views (no auth)
| fn | returns |
|---|---|
| `get_agreement(id)` | `Agreement` (`NotFound`) |
| `get_balances(id)` | `Vec<(Address, i128)>` — one entry per token in `agreement.tokens`, in order (after settlement: the base slot at 0 plus any claimable in-kind leg) |
| `value_in_base(id)` | `i128` — `balance(base) + Σ quote(token→base)`; an unquotable token counts as **0** |
| `get_config()` | `Config` |
| `is_token_allowed(token)` | `TokenInfo` (`{false,false}` for unknown tokens) |
| `next_id()` | `u64` — id the next `propose`/`open` will get |

### 3.1 Terms validation (`propose`, `open`)
`principal > 0`; `MIN_DURATION <= duration_secs <= MAX_DURATION`; `commission_bps <= 5000`;
`100 <= max_drawdown_bps <= 10000`; `customer != trader` — all `InvalidTerms`.
`base_token` must be allow-listed **with `is_base = true`** — else `TokenNotAllowed`.

### 3.2 `trade` rules (in check order)
1. `Paused` if paused. 2. `NotFound`. 3. trader auth. 4. `WrongStatus` unless Active.
5. `Expired` if `now >= end_time` **or** `deadline < now`.
6. `InvalidAmount` if `amount_in <= 0` or `min_out <= 0`.
7. `TokenNotAllowed` if `token_in == token_out` or either is not allow-listed (`is_base` not required).
8. `InsufficientBalance` if `balance(id, token_in) < amount_in`.
9. `TooManyTokens` if `token_out` is new and `tokens.len() == 6`.
10. Swap: `pair = router.router_pair_for(token_in, token_out)`; the vault pre-authorises
    `token_in.transfer(vault, pair, amount_in)` via `authorize_as_current_contract`, then calls
    `router.swap_exact_tokens_for_tokens(amount_in, min_out, [token_in, token_out], vault, deadline)`.
    Router failure → `RouterError`. The credited amount is `min(router-reported, actual balance delta)`
    and must be `>= min_out` and `> 0`, else `SlippageExceeded`.
11. Balances updated with checked math; a non-base `token_in` whose balance reaches 0 is removed
    from `tokens` (its slot is freed).
12. **Valuation pass** (one router quote per non-base holding): `value_after = value_in_base`
    (failing quote = 0). If `token_out` is not the base token and its **whole post-trade holding
    quotes to 0** in base (no `[token_out, base]` route, or a pool that cannot price it) →
    `TokenNotAllowed`: the vault never parks principal in something settlement could not sell.
13. **Drawdown check**: reject with `DrawdownBreached` if
    `value_after < principal × (10000 − max_drawdown_bps) / 10000`.
14. `agreement.last_value = value_after` (reference for §3.3). Emits `Traded{value_after}`;
    returns `amount_out`.

### 3.3 `settle` rules
* `WrongStatus` unless Active; `NotFound`. `caller` selects one of three paths:

| caller | when | auth | `min_outs` | extra floor on the realised value |
|---|---|---|---|---|
| `customer` | any time | `caller.require_auth()` | exactly `tokens.len() − 1` entries (one per **non-base token in `tokens` order**, entries for zero balances ignored), each `>= 0`, used as-is | none (the customer bears the loss and chooses their own slippage) |
| `trader` | any time | `caller.require_auth()` | as customer | `final_value >= principal × (10000 − max_drawdown_bps) / 10000` else `DrawdownBreached` — the same envelope `trade` enforces |
| `config.admin` (not a party) | `now >= end_time` else `NotExpired` | `caller.require_auth()` | empty **or** one entry per non-base token; per-token floor `max(min_outs[i], quote × (10000 − settle_slippage_bps) / 10000)` | none (the admin is trusted; the backend simulates and signs) |
| anyone else | `now >= end_time + SETTLE_GRACE_SECS` (7 days) else `NotExpired` | **none** | as admin | `final_value >= last_value × (10000 − settle_slippage_bps) / 10000` else `SlippageExceeded` |

  Wrong `min_outs` length or a negative entry → `InvalidAmount` on every path.
* **Why the keeper path is shaped like this.** A floor computed from a router quote in the same
  transaction as the swap is always satisfied, whatever the pool price: an attacker contract can
  skew the pool, call `settle`, and restore it atomically. The keeper path therefore (a) opens
  only after a 7-day head start for the parties and the admin, and (b) is bounded by
  `last_value`, a value the contract itself recorded in an earlier ledger (principal at
  activation, `value_after` on every trade). If the market moved by more than
  `settle_slippage_bps` since the last trade, a keeper cannot settle; a party (own `min_outs`) or
  the admin (after `end_time`) can. The in-contract per-token quote floor is kept on the
  admin/keeper paths only as a guard against routing inconsistencies.
* Every non-base token with balance > 0 is **quoted** (`router_get_amounts_out(balance, [token, base])`,
  one extra read per token on the party paths) and then swapped to `base_token` (same
  pre-authorisation pattern as `trade`, deadline = `now + 1`). Router failure → `RouterError`,
  whole settle rolls back.
* **In-kind delivery.** A holding whose quote is 0 (no `[token, base]` route, a pool that lost
  its liquidity, or dust below one base unit such as 1 stroop of XLM) cannot be swapped and would
  otherwise block the settlement forever. Instead it is transferred to the customer as-is with
  `try_transfer` and `Unliquidated{id, token, amount, delivered}` is emitted. If the customer
  cannot receive it (`delivered = false`, e.g. missing trustline), the balance entry is kept, the
  token stays in `tokens`, and the customer collects it later with `claim(id, token)`. In-kind
  legs are **not** part of `final_value`, so they earn no commission.
* `final_value = balance(base) + min(Σ reported outputs, actual base balance delta)`.
* Payout per §4; `trader_fee`/`platform_fee` legs use `try_transfer`: if a recipient cannot
  receive the token (no trustline / account), that leg is added to `customer_payout` instead so
  settlement can never be blocked by a third party. `customer_payout` uses a plain transfer.
* All liquidated `Balance(id, *)` entries removed, `tokens` reset to `[base_token] + undelivered
  in-kind legs`, status `Settled`, final fields stored, `last_value = final_value`, `Settled` event.

---

## 4. Settlement formula (checked i128, floor rounding)

```
final_value     = base balance after liquidation (in-kind legs excluded)
profit          = max(0, final_value − principal)
trader_fee      = profit × commission_bps   / 10_000
platform_fee    = profit × platform_fee_bps / 10_000     (config value at settle time)
customer_payout = final_value − trader_fee − platform_fee
```
Invariants (property-tested over 20k random cases with magnitudes up to ~3.7e22, plus explicit
near-`i128::MAX` cases that must return `Overflow` rather than panic): `customer_payout +
trader_fee + platform_fee == final_value`; `trader_fee + platform_fee <= profit`; on a loss the
customer receives everything and no fees are paid; on a profit `customer_payout >= principal`.

Drawdown floor (`trade`, trader `settle`): `principal × (10_000 − max_drawdown_bps) / 10_000`.
Admin/keeper per-token floor: `quote × (10_000 − settle_slippage_bps) / 10_000`.
Keeper reference floor: `last_value × (10_000 − settle_slippage_bps) / 10_000`.

---

## 5. Errors (`#[contracterror]`, u32 — ABI, never renumbered)

| code | name | raised by |
|---|---|---|
| 1 | `NotInitialized` | config missing (defensive) |
| 2 | `Unauthorized` | `propose`/`open` when the free address ≠ the party in `terms` |
| 3 | `Paused` | `propose/open/fund/accept/trade` while paused |
| 4 | `InvalidTerms` | terms/admin parameters out of range |
| 5 | `TokenNotAllowed` | token not allow-listed / not a base token / `token_in == token_out` / `token_out` holding cannot be quoted in base |
| 6 | `NotFound` | unknown agreement id |
| 7 | `WrongStatus` | action not valid in the current status (incl. `claim` on a non-settled agreement) |
| 8 | `Expired` | `trade` at/after `end_time`, or stale `deadline` |
| 9 | `NotExpired` | admin `settle` before `end_time`; any other non-party `settle` before `end_time + 7 d` |
| 10 | `InsufficientBalance` | `amount_in` > held balance; `claim` with nothing held |
| 11 | `TooManyTokens` | would exceed `MAX_TOKENS` |
| 12 | `DrawdownBreached` | post-trade value below the floor; trader-initiated `settle` realising less than the floor |
| 13 | `SlippageExceeded` | credited amount < `min_out` (vault-side re-check); keeper `settle` below the `last_value` reference floor |
| 14 | `Overflow` | checked arithmetic |
| 15 | `InvalidAmount` | `amount_in`/`min_out` ≤ 0, malformed `min_outs` |
| 16 | `RouterError` | router pair lookup / swap failed (incl. router-side slippage) |
| 17 | `NotParty` | `cancel` by an address that may not cancel |

Host-level failures (missing signature, budget) surface as non-contract errors from
simulation; the backend should map codes 1–17 to user messages and treat anything else as
"transaction failed".

---

## 6. Events (`#[contractevent]`; topic 0 = snake_case name, then `#[topic]` fields; data = map)

| event | topics | data |
|---|---|---|
| `proposed` | `id: u64, trader, customer` | `principal: i128, base_token` |
| `opened` | `id, trader, customer` | `principal, base_token` |
| `activated` | `id` | `start_time: u64, end_time: u64` |
| `cancelled` | `id` | `refunded: i128` |
| `traded` | `id, trader` | `token_in, token_out, amount_in, amount_out, value_after` |
| `unliquidated` | `id` | `token, amount: i128, delivered: bool` — emitted inside `settle`, before `settled`, once per in-kind leg |
| `settled` | `id` | `final_value, profit, trader_fee, platform_fee, customer_payout, by: Address` |
| `claimed` | `id` | `token, amount: i128` |
| `config_changed` | `key: Symbol` (`router`/`fees`/`paused`/`slippage`) | `router, platform_fee_bps, fee_recipient, paused, settle_slippage_bps` |
| `token_set` | `token` | `allowed: bool, is_base: bool` |
| `upgraded` | — | `wasm_hash: BytesN<32>` |

SAC `transfer` events are emitted alongside (escrow, swaps, payouts, in-kind legs) and can be
used to reconcile balances. The indexer should treat `unliquidated{delivered:false}` as an open
item for the customer ("Tahsil et" / claim) until the matching `claimed` event.

---

## 7. Authorization model (what the app must sign)

Transactions are built with **source account = the user**, simulated, and signed once; the
simulation returns the auth entries the vault requires. Expected trees:

| call | root auth | sub-invocations in the signed tree |
|---|---|---|
| `open(customer, terms)` | `customer` | `base_token.transfer(customer, vault, principal)` |
| `fund(id)` | `terms.customer` | `base_token.transfer(customer, vault, principal)` |
| `propose`, `accept`, `cancel`, `trade`, party `settle`, `claim` | the party | none — the vault authorises its own token movements with `authorize_as_current_contract`, and the router/SAC calls it makes are invoker-authorised |
| admin `settle` (from `end_time`) | `config.admin` | none |
| keeper `settle` (from `end_time + 7 d`) | none | none (any funded account can submit) |
| admin functions | `config.admin` | none |

Rules implemented (security checklist): every privileged path loads the authorising address
from storage (`terms.customer/trader`, `proposer`, `config.admin`); the only free-parameter
`require_auth`s are `trader`/`customer` on creation (checked against `terms`) and `caller` on
`cancel`/`settle` (checked against the stored parties / admin); router and tokens are
allow-listed; checked math everywhere; typed keys; TTL bumps in hot paths; bounded loops
(`MAX_TOKENS`); `amount <= 0` rejected; router output re-verified against real balance deltas;
slippage bounds taken from the caller on every authenticated path; no `unwrap` on storage reads;
no reinitialisation (constructor only).

---

## 8. Admin powers, trust assumptions and known limits

| Admin **can** | Admin **cannot** |
|---|---|
| allow-list / de-list tokens (`set_token`) | move, freeze or withdraw any user funds |
| change the router (`set_router`) | block `settle`, `claim` or `cancel` (pause never affects them) |
| set platform fee ≤ 10% of **profit** and its recipient | take a fee on principal or on losses |
| pause new activity (`set_paused`) | change terms of an existing agreement |
| settle an expired agreement with simulated `min_outs` (`settle` as admin, from `end_time`) | settle before `end_time`, or override a party's own `min_outs` |
| set the admin/keeper settle tolerance ≤ 50% (`set_settle_slippage`) | prevent a party from settling with their own `min_outs` |
| upgrade the code (`upgrade`) — full power over future behaviour; mitigate operationally (multisig admin, announced upgrades) | — |

Operational requirements: `fee_recipient` and traders must hold trustlines for every base token
they may receive (otherwise their fee leg is redirected to the customer); customers should hold
trustlines for the non-base tokens their trader may use, otherwise an in-kind leg waits for
`claim`; only allow-list tokens with a direct router pool against **every** base token — `trade`
refuses a `token_out` that cannot be quoted back to base, and a holding that later loses its pool
is delivered in kind rather than sold. Router change takes effect for all agreements immediately.

**Known limit — a malicious trader can bypass `max_drawdown` inside one transaction.** The
drawdown check (§3.2) and the party `settle` floors value non-base holdings with router quotes
taken in the *same* invocation as the swap. A trader who signs a transaction whose root is their
own helper contract (skew pool → `vault.trade` → restore pool; or, when `terms.trader` is a
contract address, simply a direct call) can make the quote of the token the vault just bought
read above the floor while its real value afterwards is far below it. No MEV searcher, mempool
visibility or block-ordering control is required, and the customer cannot react because the
sequence is atomic. The extractable amount scales with the trader's transient capital relative
to the pool depth (thin pools make it cheap). What the contract *does* guarantee: an honest
trader cannot exceed the drawdown; a trader-initiated `settle` cannot realise less than the
drawdown floor (so the post-expiry `settle(id, trader, [0, …])` variant is bounded to the agreed
envelope); a third party can never extract value through the keeper path; and the customer can
settle at any time with their own `min_outs`. Customers must therefore treat `max_drawdown` as a
constraint on honest traders, monitor `value_in_base` (the backend's drawdown alerts), and
settle themselves when in doubt. Closing this fully needs a manipulation-resistant reference
price (Reflector `lastprice` with a staleness bound, or the Soroswap pair's cumulative-price
TWAP) used as `min(router_quote, reference)` in the valuation and as the floor of trader
settlements; this is a roadmap item, not implemented in v1.1.

Related, lesser: a customer can lower the trader's commission by skewing the pool before their
own `settle` (fees are computed on the realised base value only) — the customer must always be
able to exit, so no floor is applied to their path. Losses are borne by the customer.

---

## 9. Mock router (`contracts/mock_router`)

Same interface subset as Soroswap: `swap_exact_tokens_for_tokens(amount_in, amount_out_min,
path, to, deadline) -> Vec<i128>` (`to.require_auth()`, pulls `amount_in` from `to`, pays from its
own balance), `router_get_amounts_out(amount_in, path) -> Vec<i128>`, `router_pair_for(a, b)`
(returns the mock's own address). Admin: `set_price(token_in, token_out, num, den)` (fixed ratio
per ordered pair), `clear_price(token_in, token_out)` (simulates a pool that lost its liquidity),
`set_strict(bool)` (lenient mode ignores `amount_out_min`, used to test the vault's re-check),
`withdraw(token, to, amount)`. Fund it by minting tokens to its address.

---

## 10. Test coverage (`cargo test`, 40 tests)

Both lifecycle paths with exact `env.auths()` trees and XDR-compared events; wrong-signer negatives
for every mutating function incl. `claim` (`mock_auths`); pause semantics; every invalid-terms
branch and boundary; token allow-list incl. mid-flight de-listing; `trade` refusing a `token_out`
with no route back to base (direct and two-hop) with full rollback; `MAX_TOKENS` bound and slot
reuse with a 5-quote/5-swap settlement whose real resources are asserted at < 10% of the mainnet
limits (limit *enforcement* is disabled for that single call because the SDK test harness also
meters its debug diagnostics against a shadow copy of the limits, which ~30 nested calls exceed;
the shadow budget never affects fees or outcomes on a network); router slippage failure, vault-side
re-check (lenient router) and drawdown breach with full rollback verified (agreement, vault and
router balances); settle with profit / loss / zero / no trades; early settle by customer and
trader; trader `settle` rejected below the drawdown floor (before and after expiry) while the
customer can always exit; admin `settle` only from `end_time`, requiring its signature and
honouring `min_outs`; keeper `settle` rejected before `end_time + 7 d`, rejected under a 100x
adverse price by the `last_value` floor, accepted at exactly the 1% tolerance, `min_outs` honoured
and validated, no auth; party settle after expiry; `min_outs` validation; unreceivable fee leg
redirected; in-kind delivery of an unquotable holding and of 1-stroop dust on the customer, trader
and keeper paths; undelivered in-kind leg kept and collected with `claim` (auth, events, status
checks); cancel/refund for both statuses; TTL assertions; sequential ids; 20k-case settlement
math invariants with a 106-bit generator that reaches the ~1.8e22 bucket plus explicit `Overflow`
cases; drawdown/slippage math. Snapshots in `contracts/*/test_snapshots/`.

---

## 11. Deviations from DESIGN.md §1 (and why)

1. **`cancel(id, caller)`** takes an extra `caller: Address`. Soroban has no "try require_auth";
   in the Funded status either party may cancel, so the contract must be told who is authorising
   and checks that address against the stored parties.
2. **`settle` after expiry is tiered** (§3.3): parties any time with their own `min_outs`;
   the admin from `end_time` with auth and honoured `min_outs`; anyone only from
   `end_time + SETTLE_GRACE_SECS` (7 days) and only if the realised value is within
   `settle_slippage_bps` of the recorded `last_value`. The spec's "anyone, no auth, in-contract
   quote floor" at `end_time` was exploitable: the same-transaction quote floor is always met, so
   any contract could sandwich an expired agreement atomically and take most of its non-base
   value. Supplied `min_outs` are never discarded (`max` with the in-contract floor).
3. **`Agreement.last_value`** (new field): the contract-recorded portfolio value that backs the
   keeper floor above. Backend `contract_abi.py` must decode it.
4. **Trader-initiated `settle` must realise at least the drawdown floor** (`DrawdownBreached`),
   mirroring `trade`, so the trader cannot liquidate at an arbitrary price post-expiry.
5. **In-kind delivery + `claim`**: a holding that quotes to 0 (no route / dust) is handed to the
   customer instead of failing every settle path forever; an undeliverable leg stays claimable.
   `Unliquidated` and `Claimed` events and the `claim` entry point were added. The spec's "an
   unquotable token counts as 0" is kept for valuation.
6. **`trade` refuses a non-base `token_out` whose holding cannot be quoted in base**
   (`TokenNotAllowed`), so principal is never parked in a token settlement cannot sell.
7. **Unreceivable fee legs** (`trader_fee`, `platform_fee`) are redirected to the customer
   instead of failing the settlement (spec did not cover a missing trustline).
8. `trade` additionally rejects `deadline < now` (`Expired`), `min_out <= 0` (`InvalidAmount`) and
   `token_in == token_out` (`TokenNotAllowed`); a fully exited non-base token leaves `tokens`.
9. Router output is cross-checked against actual balance deltas (spec only required checking the
   returned amount); the credited amount is the smaller of the two.
10. `NotExpired` (9) is used for a non-party settle before its window opens; `NotParty` (17) for
    `cancel` by a non-eligible address.
11. `settle` resets `tokens` to `[base_token]` (+ claimable in-kind legs); balances are removed
    rather than written as 0.
12. `MAX_SETTLE_SLIPPAGE_BPS = 5000` and the allow-list living in instance storage are choices the
    spec left open. An `Upgraded` event was added; `ConfigChanged` carries a `key` topic plus the
    full config. `binver` is `1.1.0` (interface grew: `claim`, `last_value`, two events).
13. Property tests use a deterministic LCG loop (20k cases) instead of the `proptest` crate.
14. Build: soroban-sdk 28 refuses `cargo build --target wasm32v1-none` outside the CLI; use
    `stellar contract build`. `upgrade` uses the SDK-28 `update_current_contract` API.
