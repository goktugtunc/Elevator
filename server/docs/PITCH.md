# TraderKirala — pitch deck outline

The handbook requires the **official Stellar Pro Hackathon presentation template** as the base (copy it,
keep its structure, add slides if needed). This outline maps our content onto the six judging criteria
so every slide earns points; drop each block into the matching template slide. Keep the deck to ~8 minutes
(finalists present live), demo included.

Numbers marked `<…>` are filled the morning of the demo from `deploy/contract.testnet.json`, the
`scripts/e2e_testnet.py` summary and stellar.expert.

---

## 1. Title (template: cover)

**TraderKirala — rent a trader, keep custody.**
Non-custodial capital-management agreements on Stellar · Soroswap-executed · TRY in/out through an anchor.
Team `<TEAM_NAME>` · track `<Genesis | Scale>` · testnet contract `<VAULT_CONTRACT_ID>`.

*Speaker note:* one sentence — "People hand their savings to traders every day; we make the trader unable
to run away with it."

## 2. Problem — criterion 1 *Meaningful idea & real-world impact*

* Retail investors in Turkey send money to signal groups / self-declared traders by bank transfer or
  exchange sub-accounts: the trader holds the money, the investor holds a promise.
* Losses beyond what was agreed, vanishing traders, unverifiable track records.
* Regulated managed accounts start at minimums far above a retail saver's budget.
* Target users: savers with ₺10k–₺500k who want market exposure without trading; skilled traders who
  want to manage capital without custody liability or a licence.

*Speaker note:* name the segment and the ticket size explicitly — the criterion asks for a "clearly
identified target user".

## 3. Solution — criterion 1 + 4 *(User experience)*

* A marketplace: **capital listings** (customer) and **service listings** (trader), swipe-to-discover,
  two-way offers, accept → **Sözleşme** whose terms live on-chain.
* The vault escrows the principal; the trader can only **swap** it on Soroswap between allow-listed
  tokens; the contract rejects any trade below `principal × (1 − max drawdown)`; the customer can settle
  any time; commission is taken from **profit only**, by code.
* Everything in TL, Yatır / Çek in the wallet — the user never sees a SEP.
* Screens: onboarding → Keşfet → Teklif → Sözleşme → Yeni İşlem → Cüzdan (show the Figma renders).

## 4. Live demo — criterion 2 *Technical implementation* + 4

Script (3 minutes, real testnet):
1. Customer logs in with the wallet, creates a capital listing (50 XLM, 1 day, 50 % max loss).
2. Trader sends an offer, customer accepts → agreement draft.
3. Customer taps **Open** → signs → `Opened` event on stellar.expert (verified run: [tx b9fdf16f…](https://stellar.expert/explorer/testnet/tx/b9fdf16ffcc8cdcb330f952782d9e4365bf45f9c0aba9c3d62f56ac283777e1a)).
4. Trader taps **Accept** → `Activated`; opens Yeni İşlem, quote XLM→USDC with drawdown headroom, signs →
   `Traded` event ([tx 3464fd09…](https://stellar.expert/explorer/testnet/tx/3464fd09bed2d44d2225b5edb3689f63f6c79b73ceacefbe6fff0d11d8691356): 10 XLM → 2.8963687 USDC via Soroswap); portfolio value updates.
5. Customer taps **Settle** → `Settled` event ([tx 8c09f2aa…](https://stellar.expert/explorer/testnet/tx/8c09f2aa11897a75b2f2a23d549943ecf7cc561ac5b4af2ec52c42f7f09e663f)); payout, commission and TL equivalent on screen.
6. Cüzdan → **Yatır** → SEP-24 page of `testanchor.stellar.org` opens in the webview; anchor transaction
   appears in "Son işlemler".

Backup: `scripts/e2e_testnet.py --anchor` output (tx hashes) in case the venue network fails.

## 5. Stellar integration — criterion 3 *Ecosystem fit* (highest weight: anchor)

* **Eligible partner: Soroswap (DeFi – DEX/Swap).** `swap_exact_tokens_for_tokens` in `trade` and
  `settle`, `router_get_amounts_out` for valuation and the drawdown rule, router quotes for `min_out`.
  *Remove Soroswap → no trading, no valuation, no settlement.*
* **Anchor / local payments: SEP-1 → SEP-10 → SEP-24 (+ SEP-12).** Testnet with `testanchor.stellar.org`;
  the workshop's TRY anchor is one env var (`ANCHOR_HOME_DOMAIN`) — everything is driven by the anchor's
  `stellar.toml` and `/info`. Withdraw uses the anchor's exact memo; statuses tracked as a state machine.
* Stellar SDKs / CLI / Skills used: stellar-sdk 16 (Python), soroban-sdk 28, `stellar` CLI 28, and the
  skill files cited by path in the README (`skills/smart-contracts/*`, `skills/data/SKILL.md`,
  `skills/standards/SKILL.md`, `skills/dapp/SKILL.md`, `CheesecakeLabs/stellar-anchor-skill/SKILL.md` +
  references, `soroswap/sdk/skills/soroswap-sdk/SKILL.md`).

## 6. Architecture — criterion 2 (Scale: Mermaid diagram required)

Paste the component diagram and the Sözleşme sequence diagram from the README (rendered images).
Talk track: mobile signs everything · API builds unsigned XDR + speaks SEP · worker indexes events ·
Postgres is a mirror, the contract is the truth · Soroswap and the anchor sit in the critical path.

## 7. Smart contract — criterion 2 *Soroban auth & storage patterns*

* `traderkirala_vault`: `propose / open / fund / accept / cancel / trade / settle`, typed errors and events,
  `__constructor`, admin can pause/upgrade but **never move funds or block settle**.
* Auth: parties loaded from storage before `require_auth`; `authorize_as_current_contract` for the router
  sub-invocation; one envelope signature per action (source account = user).
* Storage: typed `DataKey`, instance vs persistent, TTL bumps 30 → 120 days on every hot path.
* 35 `cargo test`s incl. exact auth trees, event XDR, slippage/drawdown rollback, 20 k-case settlement math.
* Deployed on testnet: `<VAULT_CONTRACT_ID>` · wasm sha256 `<…>` · router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD`.

## 8. Security & trade-offs — criterion 2 + 6

Three honest trade-offs: same-transaction quotes cannot see a sandwich (mitigated by simulated `min_out`,
customer can settle any time); admin upgrade power (multisig + announced upgrades on the roadmap);
displayed TL values are indicative. Non-custodial by construction: no user keys on the server, no
platform path to user funds.

## 9. Traction & validation — criterion 5

* `<N>` testers onboarded during the event (friendbot wallets), `<M>` agreements opened on testnet,
  `<K>` Soroswap trades executed through the vault, `<J>` anchor deposits started.
* Feedback gathered at the mentor sessions: `<two bullets>`.
* Team background: `<who ships what>`.

## 10. Roadmap & next step — criterion 5

* Passkeys / smart accounts (Smart Account Kit), fee sponsorship (fee-bump / OZ relayer).
* SEP-38 quotes, mainnet TRY anchor, Circle USDC as mainnet base asset.
* Trader automation with delegated keys under the same on-chain drawdown rule; audit, multisig admin,
  timelocked upgrades.
* **Next step: SCF / InstAward application** (Scale track: Lounge Day conversation starter).

## 11. Documentation & links — criterion 6

* GitHub `<GITHUB_REPO_URL>` — README with narrative, Mermaid diagrams, setup / testing / evaluation.
* API + OpenAPI: `https://mobilback.yolalapp.com/docs` · App: `<EXPO_EAS_OR_WEB_BUILD_URL>`.
* Vault contract on testnet: [`CCGAGVFFTH2IIH6WW2E52VVR5TJJFP3OL7HDZUZ2WQ7MT4Z57GA7NAG2`](https://stellar.expert/explorer/testnet/contract/CCGAGVFFTH2IIH6WW2E52VVR5TJJFP3OL7HDZUZ2WQ7MT4Z57GA7NAG2) — artifacts + deploy/allow-list tx hashes in `deploy/contract.testnet.json`; verified lifecycle + anchor run in README §"Verified on testnet".
* `docs/CONTRACT.md`, `docs/DESIGN.md`, `deploy/contract.testnet.json`, `scripts/e2e_testnet.py`.

## 12. Ask / closing

"We turn 'trust me' into 'verify me' for everyday investors — on Stellar, in lira, today on testnet."
Contact `<EMAIL>`.

---

### Criteria coverage check

| Judging criterion | Slides |
|---|---|
| 1 Meaningful idea & real-world impact | 2, 3 |
| 2 Technical implementation (testnet, real, auth/storage, architecture, Mermaid) | 4, 6, 7, 8 |
| 3 Ecosystem fit (partner integration load-bearing, genuine anchor flow, SDK/CLI/Skills, Skills cited) | 5 |
| 4 User experience | 3, 4 |
| 5 Traction & continuity (feedback, roadmap, next step) | 9, 10 |
| 6 Presentation & documentation | 11 (+ README) |
