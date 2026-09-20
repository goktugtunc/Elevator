# TraderKirala — Web3 Design Spec (Stellar / Soroban)

**Binding spec** for the smart contract (`contracts/vault`), the Python backend (`app/`) and the mobile
signing model. Source of truth for product scope is the Figma file "TraderKirala Mobil Tasarım Sistemi"
(renders in `design/figma/`). `docs/ARCHITECTURE.md` is superseded except where referenced.

## 0. Product decisions (derived from the Figma screens + user constraints)

| Topic | Decision |
|---|---|
| Chain | **Stellar** (user requirement). Wallets on the login screen must be Stellar wallets (in-app keypair, Freighter mobile, LOBSTR/xBull via WalletConnect). No EVM. Addresses are `G...` (or `C...` smart accounts). |
| Roles | `customer` (Müşteri: brings capital) and `trader`. One role per account, chosen at registration (Figma 1e). |
| Listings | Two kinds (Figma 5a/5b): **capital listing** by customer (sermaye, süre, piyasa, maks. kayıp, risk profili) and **service listing** by trader (strateji, komisyon %, min sermaye, piyasalar, risk seviyesi). |
| Offers | Two-way (Figma 2d/6c/6d): trader → capital listing ("Teklif Ver"), customer → trader/service listing ("Teklif İste"). Accepting an offer produces an **Agreement (Sözleşme)** whose terms go on-chain. |
| Money | Capital is a Stellar token: base asset **USDC** (default) or XLM. Amounts are shown in **TL** in the app via an FX rate the backend serves (`/api/v1/fx`). Nothing in TL exists on-chain. |
| Fiat on/off-ramp (**Anchor**) | Cüzdan → **Yatır / Çek** (Figma 8c) go through a **Stellar Anchor** using SEP-1 discovery, SEP-10 auth (user-signed), **SEP-24 interactive** deposit/withdraw (webview) and SEP-12 KYC when the anchor asks. Testnet: SDF test anchor `testanchor.stellar.org` (assets native XLM, USDC, SRT). Mainnet: a TRY anchor (configurable `ANCHOR_HOME_DOMAIN`; candidates must be verified — see §3). |
| What the trader trades | **On-chain only**: swaps through an allow-listed AMM router (Soroswap) between allow-listed tokens (XLM, USDC, EURC, …). Capital never leaves the contract; the trader can trade it but never withdraw it. BIST/forex/CFD instruments from the mock-ups cannot be executed on-chain — the "piyasalar" chips map to token categories (Kripto / Stablecoin-Forex / Stellar DeFi). |
| Profit split | Commission (komisyon) = trader's share **of positive profit only**, in bps. Loss is borne by the customer. Optional platform fee (bps of profit) to the platform address. |
| Duration & exit | Agreement has `duration` (süre). The **customer may settle (terminate) any time**; the trader may resign any time; after `end_time` **anyone** may settle. Settlement liquidates all positions to the base token and pays out — no partial withdrawals in v1. |
| Max drawdown | `max_drawdown_bps` (azami düşüş) is **enforced at trade time** in the contract: a trade that would leave portfolio value (router quotes) below `principal × (1 − max_drawdown)` is rejected. The backend also raises a notification when live value crosses the threshold. |
| Custody | Non-custodial: a single audited-style Soroban contract escrows every agreement; the platform admin can pause new activity and upgrade, but can never move user funds (settle always works, even when paused). |
| Off-chain (Postgres) | Profiles, listings, discovery feed & swipes, offers, messages, follows, favourites, ratings, notifications, push tokens, FX, indexed mirror of on-chain agreements/trades. |

## 1. Smart contract — `traderkirala_vault` (Rust, soroban-sdk 28, protocol 28)

Singleton contract, per-agreement state in persistent storage. Workspace: `contracts/` (`vault`, `mock_router`).

### 1.1 Types
```rust
#[contracttype] pub enum Status { Proposed = 0, Funded = 1, Active = 2, Settled = 3, Cancelled = 4 }
// Proposed  : created by TRADER, no funds yet   -> customer `fund` => Active
// Funded    : created+funded by CUSTOMER        -> trader `accept` => Active | customer/trader `cancel` => refund
#[contracttype] pub struct Terms {
    pub customer: Address, pub trader: Address, pub base_token: Address,
    pub principal: i128,            // amount of base_token escrowed (raw units, 7 dp for SAC)
    pub duration_secs: u64,         // süre
    pub commission_bps: u32,        // komisyon, 0..=5000
    pub max_drawdown_bps: u32,      // azami düşüş, 100..=10000 (10000 = disabled)
    pub listing_ref: BytesN<32>,    // sha256 of the off-chain listing/offer id (for indexing)
}
#[contracttype] pub struct Agreement {
    pub id: u64, pub terms: Terms, pub status: Status,
    pub proposer: Address,          // who created it (customer or trader)
    pub created_at: u64, pub start_time: u64, pub end_time: u64,   // 0 until Active
    pub tokens: Vec<Address>,       // tokens currently held (always contains base_token first), len <= MAX_TOKENS (6)
    pub settled_at: u64, pub final_value: i128, pub trader_fee: i128, pub platform_fee: i128, pub customer_payout: i128,
}
#[contracttype] pub struct Config { pub admin: Address, pub router: Address, pub platform_fee_bps: u32, pub fee_recipient: Address, pub paused: bool, pub settle_slippage_bps: u32 }
#[contracttype] pub enum DataKey { Config, NextId, Agreement(u64), Balance(u64, Address), AllowedToken(Address) /* -> TokenInfo{allowed, is_base} */ }
```
Constants: `MAX_TOKENS = 6`, `MIN_DURATION = 1 day`, `MAX_DURATION = 3 years`, `MAX_COMMISSION_BPS = 5000`, `MAX_PLATFORM_FEE_BPS = 1000`, TTL bumps: instance 30d→120d, persistent 30d→120d on every write.

### 1.2 Functions (all return `Result<_, Error>`; typed `#[contracterror]` codes are ABI, never renumber)
| fn | auth | rules |
|---|---|---|
| `__constructor(admin, router, fee_recipient, platform_fee_bps, settle_slippage_bps)` | deploy | validates bps ranges |
| `set_token(token, allowed: bool, is_base: bool)` | admin | allow-list (only allow-listed tokens can ever be traded/escrowed) |
| `set_router(router)`, `set_fees(platform_fee_bps, fee_recipient)`, `set_paused(bool)`, `set_settle_slippage(bps)`, `upgrade(wasm_hash)` | admin | `paused` blocks `propose/open/fund/accept/trade` only |
| `propose(trader, terms) -> u64` | `trader` (must equal `terms.trader`) | validates terms; status Proposed; emits `Proposed` |
| `open(customer, terms) -> u64` | `customer` (= `terms.customer`) | validates; **transfers principal** from customer to contract; status Funded; emits `Opened` |
| `fund(id)` | `terms.customer` | status Proposed; transfers principal; sets start/end; Active; emits `Activated` |
| `accept(id)` | `terms.trader` | status Funded; sets start/end; Active; emits `Activated` |
| `cancel(id)` | proposer (Proposed) or customer **or** trader (Funded) | refunds principal to customer if Funded; status Cancelled; emits `Cancelled` |
| `trade(id, token_in, token_out, amount_in, min_out, deadline) -> i128 out` | `terms.trader` | Active, `now < end_time`, not paused, both tokens allow-listed, `token_in` balance ≥ amount_in, `token_out` in `tokens` or len < MAX_TOKENS; `authorize_as_current_contract` for `token_in.transfer(contract, pair, amount_in)` then `router.swap_exact_tokens_for_tokens(amount_in, min_out, [token_in, token_out], contract, deadline)`; update balances; **drawdown check** (§1.3) else `Err(DrawdownBreached)`; emits `Traded` |
| `settle(id, caller: Address, min_outs: Vec<i128>)` | if `now < end_time`: `caller ∈ {customer, trader}` and `caller.require_auth()`; else anyone (no auth) | Active; liquidates every non-base token to base (`min_outs[i]` per non-base token in `tokens` order; when caller is not a party (post-expiry), each `min_out = quote × (1 − settle_slippage_bps)` computed in-contract and `min_outs` is ignored); computes payout (§1.4); transfers; status Settled; emits `Settled` |
| views: `get_agreement(id)`, `get_balances(id) -> Vec<(Address, i128)>`, `value_in_base(id) -> i128`, `get_config()`, `is_token_allowed(token) -> TokenInfo`, `next_id()` | none | `value_in_base` uses router quotes (0 for a token with no path) |

Errors: `NotInitialized=1, Unauthorized=2, Paused=3, InvalidTerms=4, TokenNotAllowed=5, NotFound=6, WrongStatus=7, Expired=8, NotExpired=9, InsufficientBalance=10, TooManyTokens=11, DrawdownBreached=12, SlippageExceeded=13, Overflow=14, InvalidAmount=15, RouterError=16, NotParty=17`.

Events (`#[contractevent]`, topics = name + ids/addresses): `Proposed{#id,#trader,#customer, principal, base_token}`, `Opened{...}`, `Activated{#id, start_time, end_time}`, `Cancelled{#id, refunded}`, `Traded{#id,#trader, token_in, token_out, amount_in, amount_out, value_after}`, `Settled{#id, final_value, profit, trader_fee, platform_fee, customer_payout, by}`, `ConfigChanged{...}`, `TokenSet{#token, allowed, is_base}`.

### 1.3 Valuation & drawdown
`value = balance(base) + Σ_{t≠base, balance>0} router.router_get_amounts_out(balance_t, [t, base]).last()` (a failing quote counts as 0 — conservative). Trade is rejected when `value_after < principal × (10000 − max_drawdown_bps) / 10000`. Loop bounded by `MAX_TOKENS`. Quotes come from the allow-listed router only.

### 1.4 Settlement math (checked i128 arithmetic, floor rounding, fees never exceed profit)
```
final_value     = balance(base) after liquidation
profit          = max(0, final_value − principal)
trader_fee      = profit × commission_bps / 10000
platform_fee    = profit × platform_fee_bps / 10000
customer_payout = final_value − trader_fee − platform_fee
```
Transfers: customer_payout → customer, trader_fee → trader (if > 0), platform_fee → fee_recipient (if > 0). Zero all `Balance(id, *)` entries.

### 1.5 Security requirements (from stellar-dev security checklist)
Auth loaded from storage for every privileged path (never `who.require_auth()` on a free parameter except `caller` in `settle`, which is then checked against the stored parties); allow-listed router & tokens only; checked math; typed keys; TTL extended in hot paths; `settle`/`cancel` never blocked by `paused`; `upgrade` admin-gated with `contractmeta!(binver)`; events for every state change; bounded loops; reject `amount <= 0`; re-check received amount from router return value (not trusted quote); tests assert `env.auths()` on `trade`, `fund`, `open`, `settle`.

### 1.6 `mock_router` (tests + testnet fallback)
Implements the Soroswap router subset: `swap_exact_tokens_for_tokens`, `router_get_amounts_out`, plus admin `set_price(token_in, token_out, num, den)` and `set_liquidity`/holds token balances to pay out. Same signatures as Soroswap (`to.require_auth()`, pulls `amount_in` from `to`).

### 1.7 Testing (Rust, `cargo test`)
Lifecycle happy paths (trader-initiated & customer-initiated), auth negatives via `mock_auths` for every mutating fn, paused semantics, invalid terms, token allow-list, MAX_TOKENS bound, trade slippage & drawdown breach (rollback verified: balances unchanged), settle with profit / loss / zero, post-expiry permissionless settle with in-contract min_out, early settle by customer and by trader, cancel/refund both statuses, events asserted with `to_xdr`, TTL asserted, `value_in_base` with an unquotable token, fuzz-style proptest on settlement math invariants (`customer_payout + fees == final_value`, `fees <= profit`). Test snapshots committed.

### 1.8 Deployment
`stellar contract build` → `stellar contract deploy --source-account platform --network testnet -- --admin <platform G> --router CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD --fee_recipient <platform G> --platform_fee_bps 0 --settle_slippage_bps 100`; then `set_token` for Soroswap testnet tokens: XLM `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` (base), USDC `CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F` (base), EURC `CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT`. Record `CONTRACT_ID`, wasm hash, deploy tx in `deploy/contract.testnet.json` and `.env` (`VAULT_CONTRACT_ID`). Script: `scripts/deploy_contract.sh`. Mainnet: Soroswap router `CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH`, Circle USDC SAC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`, XLM SAC `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`.

### 1.9 Amendments after the security review (binding on top of §1.1–§1.8; details in `docs/CONTRACT.md`)
The original text above is kept verbatim; where it conflicts with this list, this list wins.
1. **`settle` callers are tiered** (replaces the "else anyone (no auth)" clause of §1.2 and the §0 "after `end_time` anyone may settle"): customer/trader any time with their own `min_outs`; **admin** from `end_time`, `require_auth`, `min_outs` honoured as `max(min_outs[i], quote × (1 − settle_slippage_bps))`; **anyone else** only from `end_time + SETTLE_GRACE_SECS` (7 days), no auth, `min_outs` honoured the same way **and** `final_value ≥ last_value × (1 − settle_slippage_bps)` else `SlippageExceeded`. Rationale: a floor quoted in the same transaction as the swap is always satisfied, so the permissionless path was atomically sandwichable by any contract.
2. **`Agreement.last_value: i128`** added (principal at creation, `value_after` after every trade, `final_value` at settlement).
3. **Trader-initiated `settle`** must realise at least `principal × (1 − max_drawdown)` (`DrawdownBreached`), the same envelope `trade` enforces.
4. **In-kind delivery**: a non-base holding whose quote in base is 0 (no `[token, base]` route, or dust) is transferred to the customer as-is at settlement (`Unliquidated{#id, token, amount, delivered}`) instead of failing every settle path; if the customer cannot receive it the balance stays and **`claim(id, token)`** (customer auth, status Settled, `Claimed{#id, token, amount}`) collects it later. In-kind legs are not part of `final_value`.
5. **`trade` refuses a non-base `token_out` whose post-trade holding quotes to 0** in base (`TokenNotAllowed`), using the same valuation pass as the drawdown check.
6. Known, documented limit (CONTRACT.md §8): router quotes taken in the same transaction cannot stop a *malicious* trader from bypassing `max_drawdown` inside one signed transaction (helper contract skew → `trade` → restore). `max_drawdown` is a constraint on honest traders until a manipulation-resistant reference price (Reflector / pair TWAP) is adopted; the customer may settle at any time.
7. `contractmeta binver = 1.1.0`; error codes unchanged; §1.6 mock router gains `clear_price`.

## 2. Backend (Python 3.12 · FastAPI · SQLAlchemy 2 async · PostgreSQL 16 · stellar-sdk 16)

Keep `app/core`, `app/db`, `app/main.py`, `app/routers/meta.py`, `docker/`, `docker-compose.yml`. Reuse from `_parked/` where it fits: `services/stellar/sep10.py`, `services/auth.py`, `schemas/auth.py`, `services/notifications.py`, `services/users.py` (adapt fields), `stellar/xdr_utils.py`, `stellar/horizon.py` (classic reads/payments). Everything else is new. Conventions from `docs/ARCHITECTURE.md §3` still apply (Decimal, errors, flush-not-commit, row locks, ruff).

### 2.1 Data model (Alembic migration `0001_init`)
* `users`: id, stellar_address (G/C, unique), role (customer|trader), username, display_name, avatar_url, bio, **customer fields**: budget_amount (Numeric), risk_profile (conservative|balanced|aggressive), markets (jsonb list of `crypto|stable_fx|defi`); **trader fields**: strategy_summary, commission_bps, min_capital, markets, risk_level; expo_push_token, is_active, is_admin, timestamps, last_login_at. Stats columns maintained by indexer: `total_return_bps`, `monthly_return_bps`, `max_drawdown_bps`, `win_rate_bps`, `managed_capital`, `active_agreements`, `rating_avg`, `rating_count`.
* `auth_nonces` (as before). `assets`: id, network, contract_id (C…, SAC or token), code, issuer|null, decimals, name, icon_url, category (crypto|stable_fx|defi), is_base_allowed, is_active, onchain_allowed (mirror of contract allow-list).
* `listings`: id, owner_id, kind (capital|service), title, description, risk_profile, markets jsonb, status (active|paused|closed), **capital**: amount, base_asset_id, duration_days, max_loss_bps; **service**: commission_bps, min_capital, expected_return_min_bps/max_bps; counters view_count, like_count, offer_count; timestamps.
* `interactions`: id, user_id, target_type (listing|user), target_id, action (pass|like|save|follow|view|offer_request), unique(user_id,target_type,target_id,action).
* `follows` (follower_id, trader_id). `favorites` (user_id, listing_id).
* `offers`: id, listing_id, from_user_id, to_user_id, direction (trader_to_customer|customer_to_trader), amount, base_asset_id, duration_days, commission_bps, max_drawdown_bps, expected_return_min_bps, expected_return_max_bps, note, status (pending|accepted|rejected|withdrawn|expired), expires_at, responded_at, agreement_id|null.
* `agreements` (Sözleşme mirror): id (uuid), onchain_id (bigint, unique, null until proposed on-chain), offer_id, listing_id, customer_id, trader_id, base_asset_id, principal, duration_secs, commission_bps, max_drawdown_bps, risk_profile, listing_ref (hex32), status (draft|proposed|funded|active|settled|cancelled|failed), proposer_role, created_tx, activate_tx, settle_tx, start_time, end_time, current_value, value_updated_at, high_water_value, final_value, profit, trader_fee, platform_fee, customer_payout, settled_at, settled_by, last_event_ledger.
* `agreement_balances` (agreement_id, asset_id, balance). `trades`: id, agreement_id, onchain_seq, tx_hash, ledger, trader_id, token_in_id, token_out_id, amount_in, amount_out, value_after, note (off-chain, editable by trader), symbol_label ("XLM/USDC · Alış"), created_at, notify_investors bool.
* `agreement_value_snapshots` (agreement_id, value, at). `indexer_state` (key, cursor/ledger).
* `conversations` (id, offer_id|agreement_id, participant_a, participant_b), `messages` (id, conversation_id, sender_id, body, created_at, read_at).
* `ratings` (agreement_id unique, customer_id, trader_id, score 1-5, comment). `notifications` (as before + category listing|offer|agreement|wallet). `pending_transactions`: id, user_id, kind (open|propose|fund|accept|cancel|trade|settle|payment), agreement_id|null, unsigned_xdr, tx_hash|null, status (built|submitted|success|failed), result json, created_at, expires_at.

### 2.2 Stellar layer
* `services/stellar/soroban.py` — `SorobanGateway` (stellar_sdk `SorobanServerAsync`): `simulate`, `send`, `poll_tx(hash)`, `get_events(start_ledger, filters, cursor)`, `get_ledger_entries`, `latest_ledger`; contract reads via simulation (`get_agreement`, `get_balances`, `value_in_base`, `get_config`) with `scval` decoding; tx builders that return **unsigned, simulated & assembled XDR with source = user account** for: `open`, `propose`, `fund`, `accept`, `cancel`, `trade`, `settle`, plus classic `payment` (wallet deposit/withdraw to external address). Use `stellar_sdk.contract` (`ContractClientAsync`/`AssembledTransactionAsync`) if available in 16.1, else `TransactionBuilder.append_invoke_contract_function_op` + `prepare_transaction`. Keep the `StellarGateway` classic interface from `_parked` for balances/payments (Horizon).
* `services/contract_abi.py` — ScVal (de)serialisation for `Terms`, `Agreement`, `Status`, events.
* `services/indexer.py` — polls `getEvents` for `VAULT_CONTRACT_ID` from the persisted cursor (fallback `latest − retention`), maps events → agreements/trades rows, marks pending_transactions, notifies parties; reconciles every active agreement each N minutes via `get_agreement` + `value_in_base` (snapshots, high-water, drawdown alert at 80% and 100% of max drawdown, expiry reminders 24h/1h, auto-`settle` reminder after expiry).

### 2.3 API (prefix `/api/v1`) — mapped to Figma screens
* **Auth** (1d): `GET/POST /auth/sep10`, `POST /auth/nonce`, `POST /auth/verify`, `GET /auth/me`, `POST /auth/refresh`.
* **Registration** (1e–1g): `POST /users/register {role, username, display_name, customer:{budget_amount, risk_profile, markets} | trader:{markets, strategy_summary, commission_bps, min_capital, risk_level}}`; `GET/PATCH /users/me`; `GET /users/{id}`; `GET /traders/{id}/profile` (3e: stats, performance series from agreement snapshots, live positions = open agreements' balances, recent trades, ratings).
* **Discover** (2a–2d): `GET /discover?limit&cursor` → role-aware cards (customer sees trader/service cards; trader sees capital listings), excludes passed/liked; `POST /discover/{target_type}/{id}/action {action: pass|like|save|follow|offer_request}`; `GET /discover/remaining`.
* **Listings** (5a–5d, 9a): CRUD `POST/GET/PATCH /listings`, `GET /listings/mine?status=`, `GET /listings/{id}` (+ counters, offers for owner), `POST /listings/{id}/pause|resume|close`.
* **Offers** (2d, 6c/6d): `POST /offers`, `GET /offers?box=inbox|outbox&status=`, `GET /offers/{id}`, `POST /offers/{id}/accept` → creates `agreements` row (draft) + conversation, returns agreement; `POST /offers/{id}/reject|withdraw`.
* **Agreements / Sözleşme** (9d, 3a, 5c): `GET /agreements?role=&status=`, `GET /agreements/{id}` (terms, status, balances, value, P&L, tx hashes, TL equivalents), `POST /agreements/{id}/tx/{action}` where action ∈ `open|propose|fund|accept|cancel|settle` → `{unsigned_xdr, network_passphrase, pending_tx_id, expires_at, summary}` (validates role/status; `settle` for customer/trader anytime, for anyone post-expiry), `POST /tx/submit {pending_tx_id, signed_xdr}` → sends via RPC, polls up to 60 s, returns `{tx_hash, status, result}`; indexer fills the rest. `GET /agreements/{id}/trades`, `GET /agreements/{id}/value-history?range=`.
* **Trading** (4a/4b "Yeni İşlem"): `GET /agreements/{id}/quote?token_in&token_out&amount_in` (router quote via simulation + drawdown headroom), `POST /agreements/{id}/tx/trade {token_in, token_out, amount_in, slippage_bps, note, notify_investors}` → unsigned XDR (min_out from quote), after success indexer creates `trades` row and attaches note; `PATCH /trades/{id} {note}` (trader). `GET /activity` (3b/3c "Hareketler": trades of followed traders / agreements the user is party to, filters trader/open/closed).
* **Dashboard** (3a customer, 5c trader): `GET /dashboard` role-aware aggregates (portfolio value & change, followed traders' returns, listing interactions, managed capital, active investors, pending offers, monthly commission).
* **Wallet** (8c): `GET /wallet` (balances via Horizon/RPC for user's address incl. SAC/token balances for allow-listed assets, TL equivalents, recent on-chain movements incl. agreement flows), `POST /wallet/tx/payment {to, asset_id, amount, memo}` → unsigned classic payment XDR, `GET /wallet/deposit-info` (address + instructions + friendbot link on testnet), `GET /fx` (USD→TRY, cached 10 min; source configurable, default `https://open.er-api.com/v6/latest/USD` (rates.TRY), secondary `https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY`, fallback last cached value).
* **Messages** (9b/9c): `GET /conversations`, `GET /conversations/{id}/messages?after=`, `POST /conversations/{id}/messages`, `POST /conversations/{id}/read`.
* **Notifications** (7a–7c): list, unread-count, mark-read; categories for the tabs.
* **Follows/ratings**: `POST/DELETE /traders/{id}/follow`, `GET /traders/{id}/ratings`, `POST /agreements/{id}/rating` (customer, settled only).
* **Assets/config**: `GET /assets`, `GET /config` (network, passphrase, RPC/Horizon URLs, `vault_contract_id`, router, allow-listed tokens, fee bps).
* **Admin** (`X-Admin-Key`): stats, users, assets sync (`POST /admin/assets/sync-onchain` reads `is_token_allowed`), agreements list, indexer status/reset, `POST /admin/contract/tx/{set_token|set_paused|set_fees}` unsigned XDR for the admin key.

### 2.4 Mobile signing model
Every state-changing on-chain action = `POST …/tx/{action}` → app signs the returned XDR with the user's key (`TransactionBuilder.fromXDR(xdr, passphrase)` → `tx.sign(keypair)`) → `POST /tx/submit`. Transactions are built with **source account = the user**, so a single signature also authorises the Soroban auth entries (source-account credentials). The backend never holds user keys. Fee: user pays (testnet friendbot; mainnet: fee-bump sponsorship is a v2 item). SEP-10 domain: `mobilback.yolalapp.com`.

### 2.5 Worker
Same container image, `python -m app.worker.main`: `indexer` (events, 5 s), `reconciler` (values/snapshots/alerts, 60 s), `expiry` (offers, pending_transactions), `push` (Expo), `fx` refresh.

### 2.6 Tests
Contract: `cargo test` (§1.7). Backend: pytest with Postgres test DB + `FakeSorobanGateway` (in-memory agreement state machine that mirrors the contract semantics incl. settlement math) and `FakeStellarGateway`; API tests per screen flow; indexer tests with synthetic events; property test that the Python settlement math equals the contract formula. E2E on testnet: `scripts/e2e_testnet.py` — two friendbot-funded keypairs (customer/trader), login, register, listing, offer, accept, `open` by customer (USDC: swap XLM→USDC on Soroswap first so the customer holds USDC, or use base XLM), `accept` by trader, `trade` XLM→USDC or USDC→EURC, `settle` by customer, assert payouts and indexer state.


## 3. Anchor integration (SEP-1 / SEP-10 / SEP-24 / SEP-12) — "Yatır / Çek"

Goal: the customer funds the app wallet with fiat (TL) and cashes out, without the platform ever touching fiat. The anchor
holds the fiat licence; we integrate its standard endpoints.

### 3.1 Flow (mobile ⇄ backend ⇄ anchor)
1. **Discovery** — backend fetches `https://{ANCHOR_HOME_DOMAIN}/.well-known/stellar.toml` (SEP-1; `stellar_sdk.sep.stellar_toml.fetch_stellar_toml`) and caches `WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER_SEP0024`, `KYC_SERVER`, `SIGNING_KEY`, `CURRENCIES`; validates `NETWORK_PASSPHRASE` matches ours. `GET {TRANSFER_SERVER_SEP0024}/info` gives enabled assets, min/max, fees → exposed as `GET /api/v1/anchor/info`.
2. **Anchor auth (SEP-10, user-signed)** — `POST /api/v1/anchor/auth/challenge` → backend calls the anchor `WEB_AUTH_ENDPOINT?account=<user G>` and returns the challenge XDR after verifying it (server signing key = toml `SIGNING_KEY`, home domain, time bounds, network) with `stellar_sdk.sep.stellar_web_authentication.read_challenge_transaction`; mobile signs it with the user key; `POST /api/v1/anchor/auth/token {signed_xdr}` → backend posts it to the anchor, stores the anchor JWT in `anchor_sessions` (user_id, anchor, token, expires_at) — the anchor JWT is never sent to the mobile.
3. **Deposit (Yatır)** — `POST /api/v1/anchor/deposit {asset_code, amount?, lang}` → backend calls `POST {SEP24}/transactions/deposit/interactive` (multipart: `asset_code`, `account`, `amount`, `lang`) with the anchor JWT → returns `{type: "interactive_customer_info_needed", url, id}`; backend stores `anchor_transactions` row (kind deposit, anchor_tx_id, status incomplete) and returns `{interactive_url, anchor_tx_id}`; the mobile opens the URL in an in-app browser (`expo-web-browser`, SEP-24 §"Interactive flow"; the anchor page posts `postMessage`/callback `?callback=postMessage`). Funds arrive on the user's account as a classic payment from the anchor.
4. **Withdraw (Çek)** — `POST /api/v1/anchor/withdraw {asset_code, amount, lang}` → `POST {SEP24}/transactions/withdraw/interactive` → interactive URL; after the user completes it, the anchor transaction goes to `pending_user_transfer_start` with `withdraw_anchor_account`, `withdraw_memo`, `withdraw_memo_type`, `amount_in`; backend then builds the classic payment XDR (`POST /api/v1/anchor/transactions/{id}/tx/payment` → unsigned payment from the user to `withdraw_anchor_account` with that memo) → mobile signs → `POST /tx/submit`.
5. **Tracking** — worker `anchor_sync` polls `GET {SEP24}/transaction?id=` / `GET /transactions?asset_code=` per active session; statuses mirrored to `anchor_transactions.status` (`incomplete, pending_user_transfer_start, pending_anchor, pending_external, completed, refunded, expired, error`); notifications "Yatırma işlemi tamamlandı / Çekim tamamlandı" (Figma 7a). `GET /api/v1/anchor/transactions` lists them for the Cüzdan "Son işlemler" (8c) together with on-chain movements.
6. **KYC (SEP-12)** — when `/info` reports KYC fields or the interactive page requires it, SEP-24's hosted page handles it. Optional server-side `PUT {KYC_SERVER}/customer` pass-through (`POST /api/v1/anchor/kyc`) for anchors that need it before interactive; never store PII beyond what the anchor requires; store only the `customer id`.

### 3.2 Data & config
* Tables: `anchor_sessions` (user_id, anchor_domain, jwt (encrypted with POOL_KEY_ENCRYPTION_KEY), expires_at), `anchor_transactions` (id, user_id, anchor_domain, anchor_tx_id unique, kind deposit|withdraw, asset_code, asset_issuer, amount_in, amount_out, amount_fee, status, interactive_url, more_info_url, withdraw_anchor_account, withdraw_memo, withdraw_memo_type, stellar_tx_hash, external_tx_id, message, started_at, completed_at, raw jsonb).
* Env: `ANCHOR_HOME_DOMAIN` (testnet default `testanchor.stellar.org`), `ANCHOR_ASSETS` (testnet default `native,USDC`), `ANCHOR_ENABLED=true`, `ANCHOR_LANG=tr`.
* Asset bridging: on **testnet** the anchor delivers classic assets: `native` XLM (SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`), Circle test `USDC:GBBD47IF…` (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` — verify with `stellar contract id asset`), `SRT`. Soroswap testnet liquidity exists for **XLM** (base) ↔ its own test USDC/EURC tokens, so the **testnet default base asset is XLM**; Circle USDC's SAC is allow-listed as base but has no AMM liquidity on testnet. On **mainnet** the base asset is Circle USDC (SAC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`) delivered by USD/TRY anchors and traded on Soroswap.
* Trustlines: before a non-native deposit the user's account needs a trustline (`POST /api/v1/wallet/tx/trustline {asset_code, issuer}` → unsigned change_trust XDR); `GET /wallet` reports missing trustlines for anchor assets.
* Security: verify the anchor challenge server signature and home domain before handing it to the mobile; pin `ANCHOR_HOME_DOMAIN`; never proxy the interactive page; anchor JWT stored encrypted, scoped per user; rate-limit anchor endpoints.

## 4. Hackathon compliance — Rise In × Stellar Pro Hackathon 2026 (handbook: `2026_08_10 Rise In__ Stellar Pro Hackathon Tracks.pdf`)

Deadline: **20 Sep 2026 12:00 (Istanbul)**. Both tracks are judged on the same three requirements; every item below must be demonstrably true at submission.

| Handbook requirement | How TraderKirala satisfies it | Evidence to ship |
|---|---|---|
| **1. Integration** with an Eligible Integration Partner | **Soroswap** (DeFi – DEX/Swap): the vault contract executes every trade and every settlement liquidation through the Soroswap router (`swap_exact_tokens_for_tokens`, `router_get_amounts_out`, `router_pair_for`); the backend quotes through the same router (simulation) and the Soroswap testnet API. | Router ids in `deploy/contract.testnet.json`, `Traded` events on testnet, README section "Soroswap integration". |
| **2. Anchor / Local Payments** — "put real Turkish lira in and get a usable balance out, or the reverse" | SEP-1 → SEP-10 → **SEP-24** interactive deposit/withdraw (+ SEP-12 when required) wired into Cüzdan → Yatır/Çek (§3). Testnet demo with `testanchor.stellar.org`; the anchor is a single config value (`ANCHOR_HOME_DOMAIN`) so the TRY anchor presented at the workshop can be switched in without code changes. TL amounts shown everywhere via `/fx`. | Working deposit + withdraw on testnet in the e2e script and the app; `anchor_transactions` history in the wallet screen; README "Anchor (TRY on/off-ramp)". |
| **3. Core Feature** — integration is load-bearing | Without Soroswap there is no trading and no settlement; without the anchor there is no TL in/out. Both are in the critical path of the Sözleşme lifecycle. | Sequence diagram in README. |
| Deployed on **Stellar Testnet**, real functionality (no mocks) | Vault contract deployed with `scripts/deploy_contract.sh`; backend talks to `soroban-testnet.stellar.org` / `horizon-testnet.stellar.org`; mock router is **tests only**. | Contract id + wasm sha256 in `deploy/contract.testnet.json`, stellar.expert links in README. |
| Soroban auth & storage patterns | `require_auth` on stored parties, `authorize_as_current_contract` for the router sub-invocation, typed `DataKey`, instance vs persistent storage with TTL bumps, `__constructor`, typed errors/events (§1.5). | `docs/CONTRACT.md`, `cargo test` output. |
| Architecture documented (+ **Mermaid** diagram for Scale) | README carries a Mermaid component diagram and a sequence diagram (mobile ⇄ backend ⇄ RPC/contract ⇄ Soroswap; anchor flow). | README §Architecture. |
| Public GitHub repo, well-structured README, documented contract ids & artifacts, front-end URL, live demo | Repo initialised in `/home/mkati/mobilapp` (push to GitHub required — needs the team's GitHub remote); README with setup/test/eval instructions; Expo app (team) + API at `https://mobilback.yolalapp.com/docs`; Expo web build or EAS link for judges. | README, `deploy/`, `/docs`. |
| Cite the **Stellar Skills** used (by path) | Used during development: `skills/smart-contracts/SKILL.md`, `skills/smart-contracts/development.md`, `skills/smart-contracts/security.md`, `skills/smart-contracts/testing.md`, `skills/data/SKILL.md`, `skills/standards/SKILL.md`, `skills/dapp/SKILL.md` (stellar/stellar-dev-skill); **Anchors**: `CheesecakeLabs/stellar-anchor-skill/SKILL.md` + `references/client/discovery-and-auth.md`, `references/client/sep24-interactive.md`, `references/testing/testing-and-validation.md`; Soroswap: `soroswap/sdk/skills/soroswap-sdk/SKILL.md` (router interface verified from `soroswap/core/contracts/router/src/lib.rs`). | README §"Stellar Skills used". |
| Narrative, technical docs (architecture, components, decisions, trade-offs, challenges), pitch deck (official template) | README sections; deck to be produced from the official template once published. | README, `docs/PITCH.md` outline. |
| Bonus: passkeys / smart wallets | Not in scope for the deadline; roadmap item (Smart Account Kit). | README roadmap. |

Anchor-skill gotchas that the implementation MUST respect (from `CheesecakeLabs/stellar-anchor-skill/SKILL.md`): never submit the SEP-10 challenge to the network; pass `home_domain` and `web_auth_domain` separately; open SEP-24 URLs in a system webview (not iframe) and listen for `postMessage`; withdrawals need the exact `memo`/`memo_type` from the withdraw response; check `/info` (`features.claimable_balances` false on testanchor → the user needs a trustline before non-native deposits); amounts are decimal strings; treat transaction status as a state machine (`pending_trust`, `pending_user`, `on_hold`…); re-run SEP-10 transparently on 401; always pair `asset_code` with `asset_issuer`.
