#!/usr/bin/env python3
"""Elevator — real Stellar **testnet** end-to-end run against a live API (DESIGN §2.6; handbook:
"core user flows work end to end", "deployed on Stellar Testnet with real functionality").

Nothing is mocked. Two fresh keypairs are funded by friendbot, log in with a signed nonce, register as
customer / trader, publish listings, negotiate an offer and then drive the Sözleşme through the vault
contract on testnet by signing the XDR the API builds (exactly what the mobile app does):

    open   customer escrows the principal (XLM) in the vault          → Funded
    accept trader activates the agreement                             → Active
    trade  trader swaps 10 XLM → USDC through the Soroswap router     → Traded event
    settle customer liquidates back to XLM and receives the payout    → Settled

Every step waits for the API mirror (tx/submit result + indexer) and the summary prints agreement ids,
tx hashes (stellar.expert links), final value, profit, fees and payout.

    API_BASE=http://127.0.0.1:8012 python scripts/e2e_testnet.py            # lifecycle
    python scripts/e2e_testnet.py --anchor                                   # + SEP-1/10/24 (testanchor)
    python scripts/e2e_testnet.py --anchor-only                              # only the anchor rail
    python scripts/e2e_testnet.py --dry-run                                  # print the plan, no network

Requires: the API reachable at API_BASE with VAULT_CONTRACT_ID set (scripts/deploy_contract.sh); the
worker (indexer) running is recommended but /tx/submit already applies results optimistically.
Exit code 0 on success, 1 on any failure (the API error body is printed), 2 on bad arguments.
Only `httpx` and `stellar_sdk` are needed (no app imports), so it runs from any machine.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import httpx
from stellar_sdk import Keypair, TransactionEnvelope

DEFAULT_API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:8012")
API_PREFIX = "/api/v1"
FRIENDBOT_URL = os.environ.get("FRIENDBOT_URL", "https://friendbot.stellar.org")
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"

# Testnet token contract ids (DESIGN §1.8 / §3.2, scripts/seed_assets.py)
XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
USDC_SOROSWAP = "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F"
SOROSWAP_ROUTER_TESTNET = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"
EXPERT = "https://stellar.expert/explorer/testnet"

LOGIN_MESSAGE_PREFIX = "elevator-login:"  # app.services.auth.LOGIN_MESSAGE_PREFIX


# --- failures -----------------------------------------------------------------------------------------


class E2EFailure(Exception):
    def __init__(self, step: str, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.step = step
        self.message = message
        self.body = body


class ApiError(E2EFailure):
    def __init__(self, step: str, call: str, status: int, body: Any) -> None:
        super().__init__(step, f"{call} -> HTTP {status}", body)
        self.status = status


# --- model --------------------------------------------------------------------------------------------


@dataclass
class Actor:
    name: str
    keypair: Keypair
    token: str | None = None
    user_id: str | None = None

    @property
    def address(self) -> str:
        return self.keypair.public_key


@dataclass
class Report:
    started: float = field(default_factory=time.monotonic)
    api_base: str = ""
    network: str = ""
    vault_contract_id: str | None = None
    router_id: str | None = None
    customer: str | None = None
    trader: str | None = None
    listing_capital_id: str | None = None
    listing_service_id: str | None = None
    offer_id: str | None = None
    agreement_id: str | None = None
    onchain_id: int | None = None
    tx: dict[str, str] = field(default_factory=dict)
    quote: dict[str, Any] = field(default_factory=dict)
    trade: dict[str, Any] = field(default_factory=dict)
    final: dict[str, Any] = field(default_factory=dict)
    anchor: dict[str, Any] = field(default_factory=dict)
    steps: list[dict[str, Any]] = field(default_factory=list)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def as_dict(self) -> dict[str, Any]:
        d = {k: v for k, v in self.__dict__.items() if k != "started"}
        d["elapsed_seconds"] = round(self.elapsed, 1)
        return d


def now_tag(report: Report) -> str:
    return f"[{report.elapsed:6.1f}s]"


def say(report: Report, msg: str) -> None:
    print(f"{now_tag(report)} {msg}", flush=True)


# --- API client -----------------------------------------------------------------------------------------


class Api:
    def __init__(self, base: str, timeout: float) -> None:
        self.base = base.rstrip("/")
        self.http = httpx.AsyncClient(base_url=self.base, timeout=httpx.Timeout(timeout))
        self.step = "init"

    async def close(self) -> None:
        await self.http.aclose()

    async def call(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        expect: tuple[int, ...] = (200, 201),
        prefix: bool = True,
    ) -> Any:
        url = (API_PREFIX + path) if prefix else path
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            r = await self.http.request(method, url, json=json, params=params, headers=headers)
        except httpx.HTTPError as e:
            raise E2EFailure(self.step, f"{method} {url}: {e.__class__.__name__}: {e}") from e
        try:
            body = r.json()
        except ValueError:
            body = {"raw": r.text[:800]}
        if r.status_code not in expect:
            raise ApiError(self.step, f"{method} {url}", r.status_code, body)
        return body


# --- helpers --------------------------------------------------------------------------------------------


async def friendbot(report: Report, actor: Actor) -> None:
    async with httpx.AsyncClient(timeout=60) as http:
        r = await http.get(FRIENDBOT_URL, params={"addr": actor.address})
    if r.status_code >= 400:
        raise E2EFailure("friendbot", f"friendbot refused {actor.name} {actor.address}: HTTP {r.status_code}", r.text[:400])
    say(report, f"friendbot funded {actor.name} {actor.address}")


async def login(api: Api, report: Report, actor: Actor) -> dict[str, Any]:
    """Nonce login: POST /auth/nonce → sign `message` with the wallet key → POST /auth/verify."""
    nonce = await api.call("POST", "/auth/nonce", json={"public_key": actor.address})
    message: str = nonce["message"]
    if not message.startswith(LOGIN_MESSAGE_PREFIX):
        raise E2EFailure(api.step, f"unexpected login message {message!r}", nonce)
    signature = base64.b64encode(actor.keypair.sign(message.encode("utf-8"))).decode()
    out = await api.call(
        "POST", "/auth/verify", json={"public_key": actor.address, "nonce": nonce["nonce"], "signature": signature}
    )
    actor.token = out["token"]
    say(report, f"{actor.name} logged in (registered={out['registered']})")
    return out


async def register(api: Api, report: Report, actor: Actor, body: dict[str, Any]) -> dict[str, Any]:
    out = await api.call("POST", "/users/register", token=actor.token, json=body, expect=(201,))
    actor.token = out["token"]  # carries the role now
    actor.user_id = out["user"]["id"]
    say(report, f"{actor.name} registered as {body['role']} @{body['username']} ({actor.user_id})")
    return out


def sign_xdr(actor: Actor, xdr: str, passphrase: str) -> str:
    env = TransactionEnvelope.from_xdr(xdr, passphrase)
    env.sign(actor.keypair)
    return env.to_xdr()


async def sign_and_submit(api: Api, report: Report, actor: Actor, unsigned: dict[str, Any], *, max_wait: float, poll: float) -> dict[str, Any]:
    """Sign the XDR the API built (source = the actor, so one signature also covers the Soroban auth
    entries) and POST /tx/submit; keep polling GET /tx/{id} while the result is PENDING."""
    kind = unsigned["kind"]
    summary = unsigned.get("summary") or {}
    say(report, f"{actor.name} signs {kind} (hash {unsigned['tx_hash'][:12]}…, expires {unsigned['expires_at']}) {json.dumps(summary, default=str)[:160]}")
    signed = sign_xdr(actor, unsigned["unsigned_xdr"], unsigned["network_passphrase"])
    out = await api.call("POST", "/tx/submit", token=actor.token, json={"pending_tx_id": unsigned["pending_tx_id"], "signed_xdr": signed})
    deadline = time.monotonic() + max_wait
    while out["status"] == "PENDING" and time.monotonic() < deadline:
        say(report, f"{kind} still pending on the network, polling GET /tx/{unsigned['pending_tx_id']}")
        await asyncio.sleep(poll)
        p = await api.call("GET", f"/tx/{unsigned['pending_tx_id']}", token=actor.token)
        if p["status"] in ("success", "failed"):
            out = {**out, "status": "SUCCESS" if p["status"] == "success" else "FAILED", "result": p.get("result"), "tx_hash": p.get("tx_hash") or out["tx_hash"]}
    if out["status"] != "SUCCESS":
        raise E2EFailure(api.step, f"{kind} transaction {out.get('tx_hash')} ended with status {out['status']}: {out.get('error') or out.get('contract_error')}", out)
    report.tx[kind] = out["tx_hash"]
    say(report, f"{kind} SUCCESS tx={out['tx_hash']} ledger={out.get('ledger')} → {EXPERT}/tx/{out['tx_hash']}")
    return out


async def wait_for(report: Report, what: str, fn, *, max_wait: float, poll: float) -> Any:
    """Poll `fn()` (async, returns a truthy value when satisfied) until it does or `max_wait` passes."""
    deadline = time.monotonic() + max_wait
    last: Any = None
    while time.monotonic() < deadline:
        last = await fn()
        if last:
            return last
        await asyncio.sleep(poll)
    raise E2EFailure(what, f"timed out after {max_wait:.0f}s waiting for {what}", last)


async def wait_agreement_status(api: Api, report: Report, actor: Actor, agreement_id: str, wanted: set[str], *, max_wait: float, poll: float) -> dict[str, Any]:
    async def probe():
        ag = await api.call("GET", f"/agreements/{agreement_id}", token=actor.token)
        if ag["status"] in wanted:
            return ag
        if ag["status"] in ("failed", "cancelled") and "cancelled" not in wanted:
            raise E2EFailure(api.step, f"agreement ended in status {ag['status']}", ag)
        return None

    ag = await wait_for(report, f"agreement status in {sorted(wanted)}", probe, max_wait=max_wait, poll=poll)
    say(report, f"agreement {agreement_id} is {ag['status']} (onchain_id={ag.get('onchain_id')}, value={ag.get('current_value')})")
    return ag


def fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, str):
        try:
            return f"{Decimal(v).normalize():f}"
        except Exception:  # noqa: BLE001 - not a number
            return v
    return str(v)


# --- the lifecycle ----------------------------------------------------------------------------------------


async def run_lifecycle(api: Api, report: Report, args: argparse.Namespace, customer: Actor, trader: Actor) -> None:
    api.step = "config"
    cfg = await api.call("GET", "/config")
    report.network = cfg["network"]
    report.vault_contract_id = cfg.get("vault_contract_id")
    report.router_id = cfg.get("soroswap_router_id")
    passphrase = cfg["network_passphrase"]
    if report.network != "testnet" or passphrase != TESTNET_PASSPHRASE:
        raise E2EFailure(api.step, f"API is not on testnet (network={report.network!r})", cfg)
    if not report.vault_contract_id:
        raise E2EFailure(api.step, "VAULT_CONTRACT_ID is not configured on the API — run scripts/deploy_contract.sh testnet first", cfg)
    if cfg.get("contract_error"):
        say(report, f"warning: contract config not readable: {cfg['contract_error']}")
    say(report, f"vault={report.vault_contract_id} router={report.router_id} rpc={cfg.get('soroban_rpc_url')}")
    say(report, f"  {EXPERT}/contract/{report.vault_contract_id}")

    api.step = "assets"
    assets = await api.call("GET", "/assets")
    by_contract = {a["contract_id"]: a for a in assets}
    xlm = by_contract.get(args.base_token)
    usdc = by_contract.get(args.quote_token)
    if xlm is None or usdc is None:
        raise E2EFailure(api.step, f"base {args.base_token} / quote {args.quote_token} not in GET /assets (seed_assets?)", [a["contract_id"] for a in assets])
    if not xlm.get("onchain_allowed"):
        say(report, "warning: base asset is not flagged onchain_allowed in the DB (POST /admin/assets/sync-onchain); the contract decides anyway")
    say(report, f"base asset {xlm['code']} ({xlm['contract_id']}), quote asset {usdc['code']} ({usdc['contract_id']})")

    api.step = "friendbot"
    await asyncio.gather(friendbot(report, customer), friendbot(report, trader))

    api.step = "login"
    await login(api, report, customer)
    await login(api, report, trader)

    api.step = "register"
    tag = hex(int(time.time()))[-6:]
    await register(api, report, customer, {
        "role": "customer", "username": f"e2e_cust_{tag}", "display_name": "E2E Müşteri",
        "customer": {"budget_amount": str(args.principal), "risk_profile": "balanced", "markets": ["crypto", "stable_fx"]},
    })
    await register(api, report, trader, {
        "role": "trader", "username": f"e2e_trader_{tag}", "display_name": "E2E Trader",
        "trader": {"markets": ["crypto", "stable_fx"], "strategy_summary": "XLM/USDC momentum on Soroswap (e2e)",
                   "commission_bps": args.commission_bps, "min_capital": "10", "risk_level": "medium"},
    })

    api.step = "listings"
    service = await api.call("POST", "/listings", token=trader.token, expect=(201,), json={
        "title": "E2E Soroswap momentum", "description": "Testnet end-to-end service listing",
        "markets": ["crypto"], "commission_bps": args.commission_bps, "min_capital": "10",
        "expected_return_min_bps": 100, "expected_return_max_bps": 2000,
    })
    report.listing_service_id = service["id"]
    capital = await api.call("POST", "/listings", token=customer.token, expect=(201,), json={
        "title": "E2E sermaye ilanı", "description": "Testnet end-to-end capital listing",
        "markets": ["crypto"], "amount": str(args.principal), "base_asset_id": xlm["id"],
        "duration_days": args.duration_days, "max_loss_bps": args.max_drawdown_bps, "risk_profile": "balanced",
    })
    report.listing_capital_id = capital["id"]
    say(report, f"listings: service={service['id']} capital={capital['id']} ({fmt(capital['amount'])} {xlm['code']}, {args.duration_days}d, max loss {args.max_drawdown_bps} bps)")

    api.step = "offer"
    offer = await api.call("POST", "/offers", token=trader.token, expect=(201,), json={
        "listing_id": capital["id"], "commission_bps": args.commission_bps,
        "expected_return_min_bps": 100, "expected_return_max_bps": 2000, "note": "E2E: Teklif Ver",
    })
    report.offer_id = offer["id"]
    say(report, f"trader offered on the capital listing: offer={offer['id']} {fmt(offer['amount'])} {xlm['code']} · {offer['commission_bps']} bps · dd {offer['max_drawdown_bps']} bps")

    api.step = "accept-offer"
    accepted = await api.call("POST", f"/offers/{offer['id']}/accept", token=customer.token)
    agreement_id = accepted["agreement"]["id"]
    report.agreement_id = agreement_id
    if accepted["next_action"] != "open":
        raise E2EFailure(api.step, f"expected next_action=open for a customer acceptor, got {accepted['next_action']}", accepted)
    say(report, f"customer accepted → agreement draft {agreement_id} (conversation {accepted['conversation_id']}); next on-chain step: open")

    api.step = "open"
    unsigned = await api.call("POST", f"/agreements/{agreement_id}/tx/open", token=customer.token, json={})
    if unsigned["source"] != customer.address:
        raise E2EFailure(api.step, "unsigned open tx is not sourced by the customer", unsigned)
    out = await sign_and_submit(api, report, customer, unsigned, max_wait=args.timeout, poll=args.poll)
    report.onchain_id = out.get("onchain_id")
    ag = await wait_agreement_status(api, report, customer, agreement_id, {"funded", "active"}, max_wait=args.timeout, poll=args.poll)
    report.onchain_id = ag.get("onchain_id") or report.onchain_id

    api.step = "accept"
    unsigned = await api.call("POST", f"/agreements/{agreement_id}/tx/accept", token=trader.token, json={})
    await sign_and_submit(api, report, trader, unsigned, max_wait=args.timeout, poll=args.poll)
    ag = await wait_agreement_status(api, report, trader, agreement_id, {"active"}, max_wait=args.timeout, poll=args.poll)
    say(report, f"active: start={ag.get('start_time')} end={ag.get('end_time')} balances={[(b['asset']['code'], fmt(b['balance'])) for b in ag.get('balances', [])]}")

    api.step = "quote"
    quote = await api.call("GET", f"/agreements/{agreement_id}/quote", token=trader.token, params={
        "token_in": xlm["contract_id"], "token_out": usdc["contract_id"], "amount_in": str(args.trade_amount), "slippage_bps": args.slippage_bps,
    })
    report.quote = {k: quote.get(k) for k in ("amount_in", "amount_out", "min_out", "price", "source", "value_before", "value_after_estimate", "drawdown_floor", "headroom", "allowed", "reason")}
    say(report, f"Soroswap quote: {fmt(quote['amount_in'])} {xlm['code']} → {fmt(quote['amount_out'])} {usdc['code']} (min_out {fmt(quote['min_out'])}, price {fmt(quote['price'])}, source {quote['source']}, headroom {fmt(quote['headroom'])})")
    if not quote["allowed"]:
        raise E2EFailure(api.step, f"the trade would be rejected: {quote.get('reason')}", quote)

    api.step = "trade"
    unsigned = await api.call("POST", f"/agreements/{agreement_id}/tx/trade", token=trader.token, json={
        "token_in": xlm["contract_id"], "token_out": usdc["contract_id"], "amount_in": str(args.trade_amount),
        "slippage_bps": args.slippage_bps, "note": "E2E: XLM → USDC via Soroswap", "notify_investors": True,
    })
    out = await sign_and_submit(api, report, trader, unsigned, max_wait=args.timeout, poll=args.poll)

    async def trades_visible():
        page = await api.call("GET", f"/agreements/{agreement_id}/trades", token=trader.token)
        return page["items"] if page.get("total", 0) >= 1 else None

    trades = await wait_for(report, "the Traded event to be indexed", trades_visible, max_wait=args.timeout, poll=args.poll)
    t = trades[0]
    report.trade = {"id": t["id"], "tx_hash": t.get("tx_hash"), "amount_in": t["amount_in"], "amount_out": t["amount_out"], "value_after": t.get("value_after"), "symbol_label": t.get("symbol_label")}
    say(report, f"trade indexed: {t.get('symbol_label')} {fmt(t['amount_in'])} → {fmt(t['amount_out'])} value_after={fmt(t.get('value_after'))} tx={t.get('tx_hash')}")
    ag = await api.call("GET", f"/agreements/{agreement_id}", token=customer.token)
    say(report, f"portfolio now: value={fmt(ag.get('current_value'))} pnl={fmt(ag.get('pnl'))} balances={[(b['asset']['code'], fmt(b['balance'])) for b in ag.get('balances', [])]}")

    api.step = "settle"
    unsigned = await api.call("POST", f"/agreements/{agreement_id}/tx/settle", token=customer.token, json={"slippage_bps": args.slippage_bps})
    say(report, f"settle legs: {json.dumps((unsigned.get('summary') or {}).get('legs', (unsigned.get('summary') or {})), default=str)[:300]}")
    await sign_and_submit(api, report, customer, unsigned, max_wait=args.timeout, poll=args.poll)
    ag = await wait_agreement_status(api, report, customer, agreement_id, {"settled"}, max_wait=args.timeout, poll=args.poll)
    report.final = {k: ag.get(k) for k in ("principal", "final_value", "profit", "trader_fee", "platform_fee", "customer_payout", "settled_at", "settled_by", "settle_tx")}
    say(report, f"settled: final={fmt(ag.get('final_value'))} profit={fmt(ag.get('profit'))} trader_fee={fmt(ag.get('trader_fee'))} platform_fee={fmt(ag.get('platform_fee'))} payout={fmt(ag.get('customer_payout'))}")

    api.step = "verify"
    figures = ("final_value", "profit", "trader_fee", "platform_fee", "customer_payout")
    if any(ag.get(k) is None for k in figures):  # the Settled event may still be on its way through the indexer

        async def figures_present():
            fresh = await api.call("GET", f"/agreements/{agreement_id}", token=customer.token)
            return fresh if all(fresh.get(k) is not None for k in figures) else None

        try:
            ag = await wait_for(report, "settlement figures in the mirror", figures_present, max_wait=min(60.0, args.timeout), poll=args.poll)
            report.final = {k: ag.get(k) for k in ("principal", *figures, "settled_at", "settled_by", "settle_tx")}
        except E2EFailure:
            say(report, "warning: settlement figures are not mirrored yet (indexer lag?) — on-chain settle succeeded")
    checks: list[str] = []
    if all(ag.get(k) is not None for k in figures):
        fv, pr, tf, pf, cp = (Decimal(ag[k]) for k in figures)
        if fv != tf + pf + cp:
            checks.append(f"payout invariant broken: {fv} != {tf} + {pf} + {cp}")
        if tf + pf > pr:
            checks.append(f"fees exceed profit: {tf + pf} > {pr}")
        say(report, f"settlement math verified: {fv} = {cp} + {tf} + {pf}, fees <= profit {pr}")
    wallet = await api.call("GET", "/wallet", token=customer.token)
    bal = next((b for b in wallet.get("balances", []) if b.get("code") == xlm["code"]), None)
    say(report, f"customer wallet after settle: {xlm['code']} {fmt(bal['balance']) if bal else '-'} (TL {fmt(bal.get('value_try')) if bal else '-'}), movements={len(wallet.get('movements', []))}")
    if checks:
        raise E2EFailure(api.step, "; ".join(checks), ag)


# --- the anchor rail (SEP-1 / SEP-10 / SEP-24) ------------------------------------------------------------


async def run_anchor(api: Api, report: Report, args: argparse.Namespace, actor: Actor) -> None:
    api.step = "anchor-info"
    info = await api.call("GET", "/anchor/info", token=actor.token)
    if not info.get("enabled"):
        raise E2EFailure(api.step, "anchor is disabled on the API (ANCHOR_ENABLED=false)", info)
    if info.get("error"):
        raise E2EFailure(api.step, f"anchor discovery failed: {info['error']}", info)
    say(report, f"anchor {info['home_domain']}: web_auth={info.get('web_auth_endpoint')} sep24={info.get('transfer_server_sep24')} kyc={info.get('kyc_server')}")
    for a in info.get("assets", []):
        say(report, f"  asset {a['display_code']:>5} ({a['code']}) deposit={a['deposit_enabled']} [{fmt(a.get('deposit_min'))}..{fmt(a.get('deposit_max'))}] withdraw={a['withdraw_enabled']} trustline={a['needs_trustline']}")
    report.anchor["home_domain"] = info["home_domain"]
    report.anchor["assets"] = [a["code"] for a in info.get("assets", [])]

    api.step = "anchor-sep10"
    ch = await api.call("POST", "/anchor/auth/challenge", token=actor.token, json={})
    say(report, f"SEP-10 challenge from {ch['signing_key']} for {ch['account']} (home_domain={ch['home_domain']}, web_auth_domain={ch['web_auth_domain']}) — signing locally, NOT submitting")
    signed = sign_xdr(actor, ch["transaction"], ch["network_passphrase"])
    sess = await api.call("POST", "/anchor/auth/token", token=actor.token, json={"signed_xdr": signed})
    if not sess.get("authenticated"):
        raise E2EFailure(api.step, "anchor did not issue a session", sess)
    say(report, f"anchor session established until {sess.get('expires_at')} (JWT stays encrypted on the server)")
    report.anchor["session_expires_at"] = sess.get("expires_at")

    api.step = "anchor-deposit"
    body = {"asset_code": args.anchor_asset, "amount": str(args.anchor_amount), "lang": "tr", "callback": "postMessage"}
    dep = await api.call("POST", "/anchor/deposit", token=actor.token, json=body, expect=(201,))
    report.anchor["deposit"] = {k: dep.get(k) for k in ("id", "anchor_tx_id", "status", "interactive_url", "action")}
    say(report, f"SEP-24 interactive deposit started: anchor_tx_id={dep['anchor_tx_id']} status={dep['status']} action={dep['action']}")
    print()
    print("  ┌─ interactive step (cannot be completed headlessly) ─────────────────────────────────────")
    print("  │ open this URL in a browser / the app's system webview and complete the anchor's form:")
    print(f"  │   {dep['interactive_url']}")
    print("  │ on testanchor.stellar.org pick any amount and 'confirm'; the anchor then pays the account")
    print(f"  │   {actor.address}")
    print("  │ and the worker's anchor_sync job (every 20 s) moves the row to `completed`.")
    print("  └────────────────────────────────────────────────────────────────────────────────────────")
    print()

    api.step = "anchor-transactions"
    lst = await api.call("GET", "/anchor/transactions", token=actor.token, params={"sync": "true"})
    say(report, f"anchor transactions: total={lst['total']} synced={lst['synced']} auth_required={lst['auth_required']}")
    for t in lst["items"]:
        say(report, f"  {t['kind']:<8} {t['asset_code']:<6} {t['status']:<28} amount_in={fmt(t.get('amount_in'))} action={t['action']} id={t['anchor_tx_id']}")
    report.anchor["transactions"] = [{"anchor_tx_id": t["anchor_tx_id"], "kind": t["kind"], "status": t["status"]} for t in lst["items"]]


# --- output ------------------------------------------------------------------------------------------------


def print_summary(report: Report, ok: bool) -> None:
    print()
    print("═" * 100)
    print(f" Elevator testnet e2e — {'SUCCESS' if ok else 'FAILED'} in {report.elapsed:.1f}s  ({report.api_base})")
    print("═" * 100)
    rows: list[tuple[str, str]] = [
        ("network", report.network or "-"),
        ("vault contract", f"{report.vault_contract_id}  {EXPERT}/contract/{report.vault_contract_id}" if report.vault_contract_id else "-"),
        ("soroswap router", report.router_id or "-"),
        ("customer", report.customer or "-"),
        ("trader", report.trader or "-"),
        ("capital listing", report.listing_capital_id or "-"),
        ("service listing", report.listing_service_id or "-"),
        ("offer", report.offer_id or "-"),
        ("agreement id", report.agreement_id or "-"),
        ("onchain id", str(report.onchain_id) if report.onchain_id is not None else "-"),
    ]
    for kind in ("open", "accept", "trade", "settle"):
        h = report.tx.get(kind)
        rows.append((f"tx {kind}", f"{h}  {EXPERT}/tx/{h}" if h else "-"))
    if report.quote:
        rows.append(("quote", f"{fmt(report.quote.get('amount_in'))} → {fmt(report.quote.get('amount_out'))} (min {fmt(report.quote.get('min_out'))}, {report.quote.get('source')})"))
    if report.trade:
        rows.append(("trade", f"{report.trade.get('symbol_label')} {fmt(report.trade.get('amount_in'))} → {fmt(report.trade.get('amount_out'))} value_after {fmt(report.trade.get('value_after'))}"))
    for k in ("principal", "final_value", "profit", "trader_fee", "platform_fee", "customer_payout"):
        if report.final:
            rows.append((k.replace("_", " "), fmt(report.final.get(k))))
    if report.anchor:
        rows.append(("anchor", f"{report.anchor.get('home_domain')} assets={report.anchor.get('assets')}"))
        dep = report.anchor.get("deposit") or {}
        if dep:
            rows.append(("anchor deposit", f"{dep.get('anchor_tx_id')} status={dep.get('status')}"))
            rows.append(("interactive url", dep.get("interactive_url") or "-"))
    rows.append(("elapsed", f"{report.elapsed:.1f}s"))
    width = max(len(k) for k, _ in rows)
    for k, v in rows:
        print(f" {k:<{width}}  {v}")
    print("═" * 100)


def print_plan(args: argparse.Namespace) -> None:
    print("Elevator testnet e2e — DRY RUN (no network calls)")
    print(f"  API_BASE          {args.api_base}")
    print(f"  friendbot         {FRIENDBOT_URL}")
    print(f"  principal         {args.principal} XLM (base token {args.base_token})")
    print(f"  trade             {args.trade_amount} XLM → USDC ({args.quote_token}) slippage {args.slippage_bps} bps")
    print(f"  duration          {args.duration_days} day(s), max drawdown {args.max_drawdown_bps} bps, commission {args.commission_bps} bps")
    print(f"  timeouts          submit/poll {args.timeout}s, poll every {args.poll}s")
    print(f"  anchor            {'yes' if (args.anchor or args.anchor_only) else 'no'} (asset {args.anchor_asset}, amount {args.anchor_amount}){' — anchor only' if args.anchor_only else ''}")
    print("plan:")
    steps = [] if args.anchor_only else [
        "GET /config (testnet + VAULT_CONTRACT_ID), GET /assets (base/quote tokens by contract id)",
        "friendbot customer + trader keypairs (fresh Keypair.random())",
        "POST /auth/nonce → sign message locally → POST /auth/verify (both)",
        "POST /users/register customer + trader (role tokens)",
        "POST /listings: trader service listing, customer capital listing (XLM)",
        "POST /offers: trader → capital listing; POST /offers/{id}/accept by customer → agreement draft",
        "POST /agreements/{id}/tx/open → sign (TransactionEnvelope.from_xdr(...).sign(kp)) → POST /tx/submit → wait funded",
        "POST /agreements/{id}/tx/accept (trader) → sign → submit → wait active",
        "GET /agreements/{id}/quote XLM→USDC (Soroswap router simulation) → POST tx/trade → sign → submit → wait trades",
        "POST /agreements/{id}/tx/settle (customer, min_outs from router quote) → sign → submit → wait settled",
        "verify payout invariant, GET /wallet, print summary",
    ]
    if args.anchor or args.anchor_only:
        steps += [
            "GET /anchor/info (SEP-1 toml + SEP-24 /info)",
            "POST /anchor/auth/challenge → sign locally (never submitted) → POST /anchor/auth/token",
            f"POST /anchor/deposit {{asset_code:{args.anchor_asset}, amount:{args.anchor_amount}, lang:tr}} → print interactive URL",
            "GET /anchor/transactions",
        ]
    for i, s in enumerate(steps, 1):
        print(f"  {i:>2}. {s}")


# --- main ----------------------------------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--api-base", default=DEFAULT_API_BASE, help="API base URL (env API_BASE; default %(default)s)")
    p.add_argument("--principal", type=Decimal, default=Decimal("50"), help="XLM escrowed by the customer (default %(default)s)")
    p.add_argument("--trade-amount", type=Decimal, default=Decimal("10"), help="XLM swapped to USDC by the trader (default %(default)s)")
    p.add_argument("--duration-days", type=int, default=1, help="agreement duration in days (contract minimum 1)")
    p.add_argument("--max-drawdown-bps", type=int, default=5000, help="max loss of the capital listing (default %(default)s)")
    p.add_argument("--commission-bps", type=int, default=2000, help="trader commission on profit (default %(default)s)")
    p.add_argument("--slippage-bps", type=int, default=100, help="slippage for trade min_out and settle min_outs")
    p.add_argument("--base-token", default=XLM_SAC, help="base token contract id (default XLM SAC)")
    p.add_argument("--quote-token", default=USDC_SOROSWAP, help="token bought in the trade (default Soroswap test USDC)")
    p.add_argument("--timeout", type=float, default=180.0, help="seconds to wait for each on-chain step / mirror")
    p.add_argument("--poll", type=float, default=3.0, help="poll interval in seconds")
    p.add_argument("--anchor", action="store_true", help="after the lifecycle: SEP-1 discovery, SEP-10 auth and a SEP-24 interactive deposit")
    p.add_argument("--anchor-only", action="store_true", help="skip the agreement lifecycle; only the anchor rail (one customer)")
    p.add_argument("--anchor-asset", default="native", help="SEP-24 asset code (default native = XLM; USDC needs a trustline)")
    p.add_argument("--anchor-amount", type=Decimal, default=Decimal("10"), help="deposit amount requested from the anchor")
    p.add_argument("--json", action="store_true", help="also print the report as JSON")
    p.add_argument("--dry-run", action="store_true", help="print the plan and exit without touching the network")
    args = p.parse_args(argv)
    if args.principal <= 0 or args.trade_amount <= 0 or args.trade_amount >= args.principal:
        p.error("--trade-amount must be > 0 and smaller than --principal")
    if args.duration_days < 1:
        p.error("--duration-days must be >= 1 (contract MIN_DURATION)")
    if not (100 <= args.max_drawdown_bps <= 10_000) or not (0 <= args.commission_bps <= 5_000):
        p.error("--max-drawdown-bps must be within 100..10000 and --commission-bps within 0..5000")
    return args


async def amain(args: argparse.Namespace) -> int:
    report = Report(api_base=args.api_base)
    api = Api(args.api_base, timeout=max(30.0, args.timeout + 15))
    customer = Actor("customer", Keypair.random())
    trader = Actor("trader", Keypair.random())
    report.customer, report.trader = customer.address, trader.address
    ok = False
    try:
        api.step = "health"
        health = await api.call("GET", "/health", prefix=False, expect=(200, 503))
        if health.get("status") != "ok":
            raise E2EFailure(api.step, "API is not healthy", health)
        say(report, f"API {args.api_base} healthy (db={health.get('db')})")
        if args.anchor_only:
            cfg = await api.call("GET", "/config")
            report.network = cfg["network"]
            report.vault_contract_id = cfg.get("vault_contract_id")
            report.trader = None
            api.step = "friendbot"
            await friendbot(report, customer)
            api.step = "login"
            await login(api, report, customer)
            api.step = "register"
            await register(api, report, customer, {
                "role": "customer", "username": f"e2e_anchor_{hex(int(time.time()))[-6:]}", "display_name": "E2E Anchor",
                "customer": {"budget_amount": "100", "risk_profile": "balanced", "markets": ["crypto"]},
            })
        else:
            await run_lifecycle(api, report, args, customer, trader)
        if args.anchor or args.anchor_only:
            await run_anchor(api, report, args, customer)
        ok = True
    except E2EFailure as e:
        print()
        print(f"FAILED at step '{e.step}': {e.message}", file=sys.stderr)
        if e.body is not None:
            print(json.dumps(e.body, indent=2, default=str, ensure_ascii=False), file=sys.stderr)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
    finally:
        await api.close()
    print_summary(report, ok)
    if args.json:
        print(json.dumps(report.as_dict(), indent=2, default=str, ensure_ascii=False))
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.dry_run:
        print_plan(args)
        return 0
    return asyncio.run(amain(args))


if __name__ == "__main__":
    sys.exit(main())
