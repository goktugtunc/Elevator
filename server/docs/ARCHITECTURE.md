# MobilApp Backend — Architecture & Implementation Spec

Web3 (Stellar) "trader pools" marketplace backend. Investors fund a trader's pool; the trader
trades the pool on Stellar DEX; investors withdraw any time and profit is split by the negotiated
percentage. Mobile client = Expo app (not in this repo). Public base URL:
`https://mobilback.yolalapp.com` (Cloudflare → nginx → `127.0.0.1:8012` → uvicorn).

## 1. Stack (pinned in requirements.txt)
Python 3.12 · FastAPI · SQLAlchemy 2 async + asyncpg · Alembic · Pydantic v2 · PyJWT ·
cryptography (AES-GCM) · stellar-sdk 16.1 (`ServerAsync` + `AiohttpClient`) · PostgreSQL 16 · Docker Compose.

Processes: `api` (uvicorn, 2 workers) and `worker` (`python -m app.worker.main`, asyncio loops).

## 2. Layout & ownership
```
app/
  main.py            app factory (DONE)          app/api_deps.py  deps: DB, CurrentUser, TraderUser, InvestorUser, AdminGuard (DONE)
  core/              config, errors, security, logging (DONE)
  db/                base, session (DONE)
  models/            all ORM models + enums (DONE — the contract; change only if truly necessary and say so)
  schemas/           Pydantic I/O models (common.py DONE)
  services/          business logic (pure-ish; receives AsyncSession + gateway)
  services/stellar/  gateway.py + types.py (DONE interfaces), horizon.py (real), fake.py (tests), sep10.py
  routers/           thin HTTP layer; one module per resource; `router = APIRouter(...)`
  worker/            main.py + jobs
alembic/             env.py DONE; versions/ needs the initial migration (autogenerate)
scripts/             seed_assets.py (REQUIRED by entrypoint), bootstrap_testnet.py, gen_env.py (DONE), backup.sh (DONE)
tests/               pytest (asyncio_mode=auto); real Postgres `mobilapp_test`, FakeGateway
docker/              entrypoint.sh (DONE), initdb/
```

## 3. Conventions (all agents)
* **Money**: `Decimal` everywhere; quantize with `app.schemas.common.quantize_amount` (7 dp, ROUND_DOWN) before
  anything goes on-chain or into a `Numeric(30,7)` column. Units/NAV-per-unit keep 18 dp (`Numeric(40,18)`).
  Never use float for money.
* **Errors**: raise `app.core.errors.*` (`NotFoundError`, `ForbiddenError`, `StateError`, `ValidationError`,
  `InsufficientFundsError`, `StellarError`, `ConflictError`). `app.main` maps them to
  `{"code","message","details"}`. Routers do not construct `HTTPException` for business rules.
* **Transactions**: the request session is committed by the `get_db` dependency; services call
  `await db.flush()` and never `commit()` unless they own the session (worker). Anything touching pool unit
  accounting takes a row lock: `select(Pool).where(Pool.id==...).with_for_update()`.
* **Auth in routers**: `CurrentUser`, `TraderUser`, `InvestorUser` from `app.api_deps`; admins pass role checks.
* **IDs**: UUID4 in paths (`{listing_id}` etc.). Pagination via `PageParams` → `Page[T]`.
* **Stellar**: only `app.services.stellar.*` imports `stellar_sdk` (exception: sep10 router uses the sep10
  service). Pool secrets: `app.services.pool_keys.decrypt_pool_secret(settings, pool) -> str` (write this helper;
  wraps `app.core.security.decrypt_secret` with `associated=pool.stellar_public_key`). Never log secrets/XDR
  containing signatures at INFO.
* Type hints everywhere, `from __future__ import annotations`, ruff-clean (`ruff check app tests`).
* Logging: `logging.getLogger(__name__)`.

## 4. Assets
Whitelist table `assets` (per network). Seeded by `scripts/seed_assets.py` (idempotent; called on api start):
* testnet: `XLM` native (`is_base_allowed=true`), `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (base allowed).
* public:  `XLM` native, `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (base allowed),
  `AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA`, `yXLM:GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55`.
Admin can add/disable assets. Helpers: `services/assets.py`: `get_asset(db, id)`, `asset_ref(asset) -> AssetRef`,
`resolve_asset(db, code, issuer|None, network)`, `list_active(db, network)`.

## 5. Auth (routers/auth.py, services/auth.py, services/stellar/sep10.py)
Two wallet-login flows, both return the same JWT (`app.core.security.create_access_token`).

**A. SEP-10 (standard)** — `GET /api/v1/auth/sep10?account=G...[&memo=]` → `{"transaction": xdr, "network_passphrase"}`
built with `stellar_sdk.sep.stellar_web_authentication.build_challenge_transaction(server_secret, client_account_id,
home_domain=settings.home_domain, web_auth_domain=settings.web_auth_domain, network_passphrase, timeout=settings.sep10_challenge_timeout)`.
`POST /api/v1/auth/sep10 {"transaction": signed_xdr}` → verify with `read_challenge_transaction` +
`verify_challenge_transaction_signed_by_client_master_key` (fallback: `verify_challenge_transaction_threshold` when the
account exists on-chain and has custom signers — use gateway.get_account; if the account does not exist, master-key
verification is the rule per SEP-10). Return `{"token","expires_at","public_key","registered": bool, "user": UserOut|null}`.
Also mount the same two handlers at `GET/POST /auth` root-level? **No** — keep under API prefix; `stellar.toml`
advertises `WEB_AUTH_ENDPOINT="https://{web_auth_domain}/api/v1/auth/sep10"` and `SIGNING_KEY`.

**B. Simple message signature (mobile friendly)** —
`POST /api/v1/auth/nonce {"public_key"}` → `{"nonce","message","expires_at"}` where
`message = f"mobilapp-login:{nonce}"` (store `AuthNonce` row, TTL `settings.auth_nonce_ttl_seconds`).
`POST /api/v1/auth/verify {"public_key","nonce","signature"}` — signature = base64 of ed25519 signature over the UTF-8
bytes of `message`; verify with `Keypair.from_public_key(pk).verify(message_bytes, sig)`; nonce must be unused &
unexpired; mark used. Same response shape as SEP-10 POST.

`GET /api/v1/auth/me` → `{"public_key","registered","user"}` (valid token required, profile optional →
use `Claims` + manual lookup). `POST /api/v1/auth/refresh` (valid token → new token; keeps claims fresh from DB).
Validate `public_key` with `stellar_sdk.strkey.StrKey.is_valid_ed25519_public_key`.

## 6. Users (routers/users.py, services/users.py)
* `POST /users/register` (needs valid token, NOT registered yet) `{role: investor|trader, username, display_name, bio?, avatar_url?}`
  → `UserOut` + new token (role embedded). username: lowercase `^[a-z0-9_]{3,32}$`, unique (409 `username_taken`).
  409 `already_registered` if profile exists for the token's public key.
* `GET /users/me`, `PATCH /users/me {display_name?, bio?, avatar_url?, expo_push_token?}`, `GET /users/{id}` (public profile),
  `GET /users/by-username/{username}`.
* `GET /traders?limit&offset&sort=aum|return|investors` → `Page[TraderOut]` with stats
  (`aum`, `investor_count`, `active_listings`, `lifetime_trader_fees`, `best_return_pct`) computed from pools.
* `UserOut`: id, stellar_public_key, role, username, display_name, bio, avatar_url, created_at (never expo token).
  `MeOut` = UserOut + expo_push_token + is_admin.

## 7. Listings (routers/listings.py, services/listings.py, services/pools.py)
* `POST /listings` (trader) `{title, description, strategy?, base_asset_id, profit_share_pct, min_investment, max_pool_size?, lock_days=0, tradable_asset_ids: [uuid]}`
  → draft. Rules: base asset `is_base_allowed`; `0 <= profit_share_pct <= settings.max_profit_share_pct`;
  tradable assets active & include base asset (add it if missing); `min_investment > 0`.
* `PATCH /listings/{id}` (owner): while `draft` everything; after publish only title/description/strategy/min_investment/max_pool_size
  and `profit_share_pct` (applies to *new* investments only) — `base_asset`, `lock_days` frozen. Adding tradable assets after
  publish is allowed: call `gateway.add_trustlines(pool_secret, assets)`; removing is not.
* `POST /listings/{id}/publish` (owner, draft→active): **creates the pool** — `services/pools.create_pool_for_listing`:
  `Keypair.random()` → `encrypt_secret(settings, kp.secret, associated=kp.public_key)`; insert `Pool(status=initializing)`;
  `flush`; call `gateway.create_pool_account(platform_secret, kp.secret, settings.pool_funding_xlm, trust_assets)`;
  set `reserve_xlm = pool_funding_xlm - submit.fee_charged_xlm`, `setup_tx_hash`, `status=active`, listing `active`,
  `published_at`. If the Stellar call fails → raise `StellarError` (transaction rolled back, nothing persisted).
  Pre-check: trader's own account must exist on-chain and hold a trustline for the base asset (needed for fee payouts) —
  else `ValidationError(code="trader_trustline_missing")`.
* `POST /listings/{id}/pause` (active→paused), `POST /listings/{id}/resume` (paused→active),
  `POST /listings/{id}/close` (→closed; allowed only when pool `total_units == 0`, else 409 `pool_not_empty`).
* `GET /listings?status=active&base_asset_id&trader_id&q&sort=newest|aum|return&limit&offset` (public; non-owners only see
  active/paused), `GET /listings/{id}` → `ListingOut` incl. trader (UserOut), base_asset, tradable_assets, pool summary
  (`PoolSummary`: id, stellar_public_key, status, nav, nav_per_unit, total_units, investor_count, return_pct
  (= nav_per_unit − 1 as %; null when no units), lifetime figures), `GET /listings/mine` (trader).

## 8. Offers (routers/offers.py, services/offers.py)
`POST /offers {listing_id, to_user_id?, amount, profit_share_pct, message?, expires_in_hours=72}`.
Direction is derived from sender role: investor→trader (`to_user_id` = listing.trader_id, may be omitted),
trader→investor (`to_user_id` required, must be an investor; sender must own the listing). Listing must be `active`,
`amount >= listing.min_investment`, pct within `[0, max_profit_share_pct]`. One pending offer per (from,to,listing) → 409.
`GET /offers?box=inbox|outbox|all&status=` · `GET /offers/{id}` (party only) ·
`POST /offers/{id}/accept` (recipient) → status accepted, **creates Investment** via
`services/investments.create_investment(db, gw, investor, listing, amount, profit_share_pct, offer=offer)` and returns
`{"offer": OfferOut, "investment": InvestmentOut, "deposit": DepositInstructions}`.
`POST /offers/{id}/reject` (recipient), `POST /offers/{id}/withdraw` (sender). Worker expires stale offers.
Every transition creates a `Notification` for the counterparty (`services/notifications.notify(db, user_id, type, title, body, data)`).

## 9. Investments & deposits (routers/investments.py, services/investments.py)
* `POST /investments {listing_id, amount}` (investor) → `create_investment`:
  listing active; `amount >= min_investment`; `max_pool_size` not exceeded (`last_nav or total_cost_basis` + pending); investor's
  Stellar account exists and has a trustline for the base asset (`gateway.get_account`) else 422 `investor_account_not_ready`
  (details tell the client what's missing; for XLM base require balance ≥ amount + 1); deposit memo =
  `"INV-" + first 12 chars of uuid hex uppercase` (unique, ≤ 28 bytes); `deposit_expires_at = now + deposit_ttl_minutes`;
  `profit_share_pct` from offer or listing; `lock_until = None` (set on deposit if lock_days). Response:
  ```json
  {"investment": InvestmentOut, "deposit": {"destination": "G...pool", "asset": {"code","issuer"}, "amount": "100.0000000",
   "memo": "INV-...", "memo_type": "text", "network_passphrase": "...", "unsigned_xdr": "AAAA...", "expires_at": "..."}}
  ```
  `unsigned_xdr` from `gateway.build_payment_xdr(investor_pk, pool_pk, asset, amount, memo)`; if the investor account
  can't be loaded, `unsigned_xdr` is null and `details.reason` explains.
* `POST /investments/{id}/submit {"signed_xdr"}` (owner, pending_deposit): `gateway.parse_payment_xdr` must show
  source == investor key, destination == pool key, asset == base, amount == investment.amount, memo == deposit_memo;
  then `gateway.submit_xdr` → on success `services/deposits.credit_deposit(db, pool, investment, amount, tx_hash)`
  (see §12) and return `InvestmentOut` (status active). Horizon failure → 502 `StellarError` w/ result codes;
  if Horizon says tx already applied (`tx_bad_seq` + hash exists via `get_transaction` successful) → treat as success.
* `GET /investments?status=` (mine as investor; trader sees investments into their listings via
  `GET /listings/{id}/investments`), `GET /investments/{id}` (investor, or trader of the listing) → `InvestmentOut`:
  id, listing (id,title), pool_id, amount, deposited_amount, units, cost_basis, profit_share_pct, status, deposit_memo,
  deposit_tx_hash, deposit_expires_at, deposited_at, lock_until, **current_value** (units × pool.last_nav_per_unit, null if unknown),
  **unrealized_profit**, total_withdrawn, total_trader_fees, created_at.
* `POST /investments/{id}/cancel` (owner, pending_deposit → cancelled). Worker expires pending deposits past TTL
  (a late deposit that still arrives with a memo of an expired/cancelled investment is credited anyway if the pool is active —
  memo match wins; log it — otherwise it is recorded as an unmatched deposit, see §12).
* `POST /investments/{id}/withdraw {"units"?: "12.5", "all": true}` (owner, active; lock_until passed; pool not `closed`... closed pools
  still allow withdrawals; pool `frozen` allows too) → creates `Withdrawal(pending)`, sets investment `withdrawing`
  (only one in-flight withdrawal per investment → 409). Returns `WithdrawalOut`. Processing is asynchronous (worker §13).
  `GET /investments/{id}/withdrawals`.

## 10. Pools & trades (routers/pools.py, routers/trades.py, services/pools.py, services/trading.py, services/nav.py)
* `GET /pools/{id}` → `PoolOut`: summary + `balances: [{asset, balance, available, value_in_base}]` (live from gateway),
  `nav`, `nav_per_unit`, `return_pct`, `reserve_xlm`, open offers. `GET /pools/{id}/nav-history?range=1d|7d|30d|all` →
  snapshots. `GET /pools/{id}/trades` (public, paginated). `GET /pools/{id}/investors` (trader owner; masks investor keys to
  `G...XXXX`? no — show username + amount; keys are public anyway).
* `services/nav.py`:
  `async def compute_nav(gw, pool, base: AssetRef, tradable: list[AssetRef]) -> NavResult` with
  `NavResult(nav: Decimal, per_asset: dict[str, {balance, value, priced: bool}], unpriced: list[str], account: AccountInfo)`:
  base value = balance (for XLM base: `max(0, balance − pool.reserve_xlm)`); for XLM non-base holdings also subtract
  `reserve_xlm`; each other asset: `gw.quote_strict_send(asset, balance, base)` → dest_amount (0 & `unpriced` if None).
  Open-offer liabilities are part of `balance`, so nothing extra to add.
  `nav_per_unit = nav / total_units` (None if 0 units). `persist_snapshot(db, pool, nav_result)` updates `last_nav*` and adds
  `PoolNavSnapshot`.
* Trading (trader owner only; pool `active`; listing not `closed`):
  `POST /pools/{id}/trades` body variants (discriminated by `kind`):
  - `market_swap {sell_asset_id, buy_asset_id, sell_amount, slippage_pct?}` → quote via `gw.quote_strict_send`; 400
    `no_path` if none; `dest_min = quantize(quote.dest_amount × (1 − slippage/100))`; `gw.path_payment_strict_send(secret, ...)`;
    record `Trade` with `buy_amount = received`. Check available balance (`Balance.available`) ≥ sell_amount, and for XLM keep
    `available − sell_amount ≥ pool_min_xlm_reserve`.
  - `limit_sell {sell_asset_id, buy_asset_id, sell_amount, price}` → `manage_sell_offer`; `onchain_offer_id` from result.
  - `limit_buy {sell_asset_id, buy_asset_id, buy_amount, price}` → `manage_buy_offer` (`sell_amount` column stores
    `buy_amount × price` estimate; note in `Trade.error=None`).
  - `cancel_offer {sell_asset_id, buy_asset_id, offer_id}` → `gw.cancel_offer`.
  Both assets must be in the listing's tradable set. After every successful trade: `pool.reserve_xlm −= fee_charged_xlm`
  (floor 0) and recompute + persist NAV snapshot (best effort, log on failure).
  `GET /pools/{id}/quote?sell_asset_id&buy_asset_id&sell_amount` → `{dest_amount, price, path}` (any authenticated user).
  `GET /pools/{id}/offers` → open on-chain offers.
* Admin: `POST /admin/pools/{id}/freeze|unfreeze`.

## 11. Withdrawals (routers/withdrawals.py) — `GET /withdrawals/{id}` (investor or listing trader), `GET /withdrawals?status=` (mine).
Trader view: `GET /listings/{id}/withdrawals`.

## 12. Deposit crediting — `services/deposits.py`
```python
async def credit_deposit(db, gw, pool: Pool, investment: Investment, amount: Decimal, tx_hash: str) -> None
```
Called with the pool row locked (`with_for_update`). Idempotent on `tx_hash` (unique) — return silently if already credited.
1. `nav = compute_nav(...)` **before** counting the new deposit: the on-chain balance already includes it, so
   `nav_before = nav.nav − amount` (floor 0).
2. `units = amount` if `pool.total_units == 0` else `amount × pool.total_units / nav_before`
   (if `nav_before == 0` but units > 0 — pool wiped out — treat as fresh: units = amount). Keep 18 dp.
3. investment: `units += units`, `deposited_amount += amount`, `cost_basis += amount`, `status=active`,
   `deposit_tx_hash`, `deposited_at=now`, `lock_until = now + lock_days` if lock_days > 0.
   pool: `total_units += units`, `total_cost_basis += amount`, `lifetime_deposits += amount`, `investor_count` =
   distinct active investors (recount). Snapshot NAV. Notify investor (`deposit_confirmed`) and trader (`new_investment`).
4. Amount tolerance: if on-chain amount ≠ investment.amount, credit the **actual** amount (≥ 1 stroop) and log a warning;
   the client may pay any amount ≥ min_investment; below min_investment still credited (it is their money) but flagged in log.

Deposit watcher (worker) per active/paused pool: `gw.fetch_payments(pool_pk, pool.payments_cursor)`; for each record with
`destination == pool_pk` and `asset == base`: match `Investment.deposit_memo == record.memo` (status in pending_deposit/expired/cancelled)
→ lock pool → `credit_deposit`. No match → log warning `unmatched_deposit` (v1: funds stay in pool as unattributed; NAV
accrues to existing investors). Persist `payments_cursor` after each batch (own transaction per pool).
Initial cursor: set to the paging_token of the pool's setup transaction time — simplest: when creating the pool, after the
setup tx, call `fetch_payments(pool_pk, None)` once and store the last cursor (so funding isn't treated as a deposit; the funding
is `create_account` in XLM which is skipped anyway because op_type/asset checks — but still set the cursor).

## 13. Withdrawal processing — `services/withdrawals.py` (worker calls `process_withdrawal(db, gw, settings, withdrawal_id)`)
Own transaction; lock pool + investment (`with_for_update`, pool first). Steps, each persisted as it happens:
1. `status=processing`, `attempts += 1`, `processing_started_at`. Guards: investment active/withdrawing, `units ≤ investment.units`.
2. `fraction = units / pool.total_units`. `account = gw.get_account(pool_pk)`; base_available = base balance available
   (XLM: minus `reserve_xlm`). For every non-base asset with `available > 0`: leg `send = quantize(available × fraction)`;
   skip legs < 0.0000001; `quote = quote_strict_send(asset, send, base)` → if None → **fail** withdrawal (`error="no_path:<asset>"`, retryable,
   trader is notified `liquidation_failed` so they can unwind manually) ; `dest_min = quantize(quote.dest_amount × (1 − default_slippage/100))`.
   If any legs: `submit, received = gw.liquidate(secret, legs)`; record one `Trade(kind=liquidation, withdrawal_id, trader_id=None)`
   per leg with `buy_amount`; `liquidation_tx_hash`; `reserve_xlm −= fee`.
   `gross_value = quantize(base_available × fraction) + Σ received`. (Assets that are *unpriced* and have zero quote are treated
   as failing above — never silently zero.)
3. `cost_basis_part = quantize(investment.cost_basis × units / investment.units)`; `profit = max(0, gross − cost_basis_part)`;
   `trader_fee = quantize(profit × pct/100)`; `platform_fee = quantize(profit × settings.platform_fee_pct/100)`;
   `net = gross − trader_fee − platform_fee`. Ensure pool base available after liquidation ≥ net (else fail `insufficient_pool_balance`).
4. Payout tx: `gw.pay(secret, [PaymentInstruction(investor_pk, base, net)], memo_text=f"WD-{id.hex[:12].upper()}")` →
   `payout_tx_hash`. Investor must have trustline (checked at creation; if payment fails with `op_no_trust` → fail with clear error).
   Fees: create `FeePayout(kind="trader", amount=trader_fee, recipient=trader)` and (if > 0) `FeePayout(kind="platform",
   recipient_public_key=platform public key)`; worker's fee-payout job pays them (`gw.pay`) with retries; failures never block the investor.
5. Book-keeping: `investment.units −= units`, `cost_basis −= cost_basis_part`, `total_withdrawn += net`, `total_trader_fees += trader_fee`,
   status `withdrawn` if units == 0 else `active`; `pool.total_units −= units`, `total_cost_basis −= cost_basis_part`,
   `lifetime_withdrawals += net`, `lifetime_trader_fees += trader_fee`, `lifetime_platform_fees += platform_fee`, `reserve_xlm −= fee`,
   `investor_count` recount. `withdrawal` fields filled, `status=completed`, `completed_at`. Snapshot NAV.
   Notifications: investor `withdrawal_completed`, trader `profit_share_earned` (if fee > 0).
6. Failure handling: any exception → `status=failed`, `error=str(e)[:2000]`, investment back to `active`, `rollback` of unit changes
   (they only happen in step 5, after chain success). Worker retries `failed` withdrawals with `attempts < 5` every 60 s ×
   attempts (backoff); after that they stay failed and are visible to admin (`GET /admin/withdrawals?status=failed`,
   `POST /admin/withdrawals/{id}/retry`). **Crash safety**: a withdrawal stuck in `processing` for > 10 min with a
   `payout_tx_hash` set → verify via `gw.get_transaction` and complete book-keeping; with only `liquidation_tx_hash` → continue at step 3;
   with neither → reset to `pending`.

## 14. Worker — `app/worker/main.py`
asyncio tasks (each: `while True: try job() except log; await sleep(interval)`), single process, graceful SIGTERM:
`deposit_watcher` (settings.worker_deposit_poll_seconds), `withdrawal_processor` (worker_withdrawal_poll_seconds, processes
pending + retryable failed + stuck), `fee_payout_job` (30 s), `nav_snapshot_job` (worker_nav_snapshot_seconds, every active/paused pool),
`expiry_job` (worker_offer_expiry_seconds: offers past `expires_at` → expired; investments `pending_deposit` past
`deposit_expires_at` → expired; notify), `push_job` (optional: sends unsent Expo pushes when `expo_push_enabled` — Notification gets a
`data["push_sent"]` flag; use httpx POST to `settings.expo_push_url` with `{"to", "title", "body", "data"}`). Use
`get_session_factory()`; one short transaction per unit of work. Log every job tick at DEBUG, actions at INFO.

## 15. Meta — `routers/meta.py`
`GET /health` → `{"status":"ok","db":"ok","version"}` (503 with `db:"error"` on DB failure). `GET /health/stellar` → horizon
reachability. `GET /.well-known/stellar.toml` (text/plain; CORS `*`): `VERSION`, `NETWORK_PASSPHRASE`, `WEB_AUTH_ENDPOINT`,
`SIGNING_KEY` (public of SEP10 secret), `ACCOUNTS=[platform public]`. `GET /api/v1/config` → public client config:
`{"network","network_passphrase","horizon_url","home_domain","assets":[...],"platform_fee_pct","max_profit_share_pct","deposit_ttl_minutes"}`.

## 16. Admin — `routers/admin.py` (all under `/admin`, `dependencies=[AdminGuard]`, header `X-Admin-Key`)
`GET /admin/stats` (users by role, listings by status, total AUM, pending withdrawals, failed withdrawals, unpaid fees),
`GET /admin/users?q=&role=` · `PATCH /admin/users/{id} {role?, is_active?, is_admin?}` · `POST /admin/assets` · `PATCH /admin/assets/{id}`
· `GET /admin/withdrawals?status=` · `POST /admin/withdrawals/{id}/retry` · `POST /admin/pools/{id}/freeze|unfreeze` ·
`POST /admin/pools/{id}/snapshot` (force NAV).

## 17. Notifications — `routers/notifications.py`: `GET /notifications?unread_only&limit&offset`, `POST /notifications/read {ids: []|all: true}`,
`GET /notifications/unread-count`.

## 18. Horizon gateway — `services/stellar/horizon.py` (class `HorizonGateway(StellarGateway)`)
* `ServerAsync(settings.effective_horizon_url, client=AiohttpClient(request_timeout=15, post_timeout=40))`; `network_passphrase`.
* `get_account`: `server.accounts().account_id(pk).call()` → map balances (`asset_type` native / credit_alphanum4/12; parse
  `balance`, `selling_liabilities`, `buying_liabilities`, `limit`), `sequence` int, `subentry_count`. `NotFoundError` from SDK → None.
* `fetch_payments`: `server.payments().for_account(pk).cursor(cursor or "0").order(desc=False).limit(limit).join("transactions").include_failed(False).call()`;
  map `payment`, `path_payment_strict_send`, `path_payment_strict_receive`, `create_account` (asset native, amount=starting_balance,
  destination=account, source_account=funder); memo from embedded `transaction.memo` when `memo_type == "text"`.
* `quote_strict_send`: `server.strict_send_paths(send_asset, amount, [dest_asset]).call()` → pick max `destination_amount`; path
  from record `path` list.
* `orderbook_mid_price`: `server.orderbook(selling, buying).limit(1).call()`.
* Transactions: `Account(pk, sequence)` from `load_account`; `TransactionBuilder(source, passphrase, base_fee=settings.base_fee_stroops)`
  `.set_timeout(settings.tx_timeout_seconds)`; sign; `submit_transaction`. Map response: `hash`, `ledger`, `successful`,
  `fee_charged` (int, stroops), `result_xdr`, `envelope_xdr`. On `BadRequestError` extract
  `e.extras["result_codes"]` → `StellarError(f"tx failed: {codes}", details={"result_codes": codes})`. Wrap
  `ConnectionError`/`BadResponseError` → `StellarError`.
* `create_pool_account`: funder as tx source; ops: `append_create_account_op(new_pk, starting_balance)`, then
  `append_change_trust_op(asset, source=new_pk)` per non-native asset; sign with both keypairs.
* `path_payment_strict_send`: destination defaults to own pk; parse received amount:
  `TransactionResult.from_xdr(result_xdr).result.results[i].tr.path_payment_strict_send_result.success.last.amount.int64 / 1e7`
  (via `stellar_sdk.xdr`). `liquidate` = same with N ops → list of received.
* `manage_sell_offer`/`manage_buy_offer`: price as `Decimal` string (SDK builds Price via fraction); offer id from
  `ManageSellOfferResult.success.offer` (`offer.created/updated` → offer_id; `deleted`/None → None).
* `pay`: N payment ops; `add_text_memo` when provided (≤ 28 bytes).
* `build_payment_xdr`: `load_account(source)` (NotFound → `StellarError(code="account_not_found")`), one payment op, text memo,
  timeout, return `tx.to_xdr()` unsigned.
* `parse_payment_xdr`: `TransactionEnvelope.from_xdr(xdr, passphrase)`; exactly one `Payment` op; memo `MemoText` →
  decode utf-8; return tuple. `submit_xdr`: `server.submit_transaction(xdr)`.
* `fund_with_friendbot`: `aiohttp`/`httpx` GET `settings.effective_friendbot_url?addr=pk` (testnet only).

## 19. FakeGateway — `services/stellar/fake.py`
In-memory ledger: `accounts: dict[pk, dict[canonical_asset, Decimal]]`, `sequence`, `payments: list[PaymentRecord]`,
configurable `prices: dict[(sell_canon, buy_canon), Decimal]` (dest = amount × price), `fail_next: Exception|None`.
Helpers for tests: `fund(pk, asset, amount)`, `deposit_from_client(source_pk, pool_pk, asset, amount, memo) -> tx_hash`
(appends a PaymentRecord + moves balance), `set_price`. Signing: `Keypair.from_secret(secret).public_key` to resolve
account; deterministic tx hashes (`sha256(counter)`); `fee_charged_stroops = 100 × ops`. Implement every abstract method.

## 20. Scripts
* `scripts/seed_assets.py`: `python -m scripts.seed_assets` — upsert §4 assets for `settings.stellar_network`.
* `scripts/bootstrap_testnet.py`: ensure platform & SEP-10 accounts exist (friendbot if testnet); print public keys & balances.
* `scripts/e2e_testnet.py` (integration agent): full flow against the *running* API using two fresh friendbot-funded keypairs
  (trader + investor): register both, trader adds USDC trustline? (keep base = XLM to avoid trustline dance; USDC covered by unit
  tests), create+publish listing, investor creates investment, signs XDR locally, submits, waits for active, trader market_swap
  XLM→USDC (pool has USDC trustline), investor withdraws all, wait completed, print balances & fee. Exit non-zero on failure.

## 21. Tests (tests/)
`conftest.py`: session-scoped engine on `DATABASE_URL_TEST` (default `postgresql+asyncpg://mobilapp:${POSTGRES_PASSWORD}@db:5432/mobilapp_test`);
create schema via `Base.metadata.create_all` per session (drop after); function-scoped transactional rollback (or truncate all
tables per test); `set_gateway(FakeGateway(...))`; `httpx.AsyncClient(transport=ASGITransport(app))`; helpers `auth_token(pk)` that
performs the nonce flow with a `Keypair.random()`. Settings for tests via env: `APP_ENV=test`, dummy secrets (see docker compose `test`
usage in README). Cover: auth (nonce + SEP-10 happy/invalid), register/role guards, listing lifecycle + publish creates pool,
offers accept → investment, deposit submit → units math (first deposit 1:1, second deposit at NAV 2× gets half units),
market swap validation & recording, withdrawal full math incl. fee split & FeePayout creation, partial withdrawal, lock period,
worker expiry job, admin guard, `credit_deposit` idempotency, `nav` with unpriced asset.

## 22. Runbook (server)
```
sudo docker compose build && sudo docker compose up -d           # api runs migrations + seed
sudo docker compose run --rm api migrate revision --autogenerate -m "..."   # new migration
sudo docker compose run --rm -e APP_ENV=test api test -q          # tests (uses mobilapp_test db)
sudo docker compose logs -f api worker
```
