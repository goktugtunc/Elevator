"""Cüzdan (Figma 8c) — DESIGN §2.3 "Wallet" + §3.2 trustlines.

* ``get_wallet``: balances of the user's address — classic balances (native + trustlines) from Horizon,
  SAC / pure Soroban token balances of allow-listed assets through the Soroban gateway (``balance()``
  simulation), TL equivalents through the shared ``TlConverter`` (USD/TRY from ``/fx`` × USD price), the
  trustlines still missing for the anchor's assets, and the recent movements = classic payments +
  agreement flows (escrow / payout / refund) + anchor deposits / withdrawals merged newest first.
* ``deposit_info``: address, SEP-7 pay URI, friendbot link on testnet, anchor assets with limits and the
  trustline status per asset.
* ``build_payment`` / ``build_trustline``: unsigned classic XDR with source = the user (signed by the
  mobile, submitted through ``POST /tx/submit``), recorded in ``pending_transactions``.

Everything reads the real network through the gateways; nothing is cached or hard-coded here.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from urllib.parse import urlencode

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import NotFoundError, StellarError, ValidationError
from app.models import (
    Agreement,
    AgreementStatus,
    AnchorTransaction,
    AnchorTxKind,
    Asset,
    PendingTransaction,
    PendingTxKind,
    User,
    UserRole,
)
from app.schemas.tx import UnsignedTxOut
from app.schemas.wallet import (
    DepositInfoAssetOut,
    DepositInfoOut,
    MissingTrustlineOut,
    MovementOut,
    TrustlineIn,
    WalletBalanceOut,
    WalletFxOut,
    WalletOut,
    WalletPaymentIn,
)
from app.services import amounts as money
from app.services import anchor as anchor_service
from app.services.agreements import TlConverter, asset_brief, record_pending, tl_converter, unsigned_out
from app.services.amounts import quantize
from app.services.anchor import NATIVE, AnchorClient, AnchorError, display_code, is_g_account
from app.services.stellar.types import AccountInfo, AssetRef, PaymentRecord, UnsignedTx

log = logging.getLogger(__name__)

PAYMENT_PAGE = 200
MAX_PAYMENT_PAGES = 5
DEFAULT_MOVEMENTS = 20


def now_utc() -> datetime:
    return datetime.now(UTC)


def _ref(asset: Asset) -> AssetRef:
    return AssetRef.native() if asset.is_native else AssetRef(asset.code, asset.issuer)


def _parse_iso(value: str) -> datetime:
    v = (value or "").strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return now_utc()
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


# --- anchor assets (best effort: the wallet must render even when the anchor is down) ----------------------


async def anchor_asset_refs(db: AsyncSession, settings: Settings, anchor: AnchorClient | None) -> tuple[list[tuple[str, str | None]], str | None]:
    """[(anchor code, issuer)] for ``ANCHOR_ASSETS``: issuers from the anchor toml, falling back to the
    allow-listed asset rows of the network. Second value = anchor error message (None when fine)."""
    codes = anchor_service.offered_codes(settings)
    if not settings.anchor_enabled:
        return [], None
    error: str | None = None
    issuers: dict[str, str | None] = {}
    if anchor is not None:
        try:
            disc = await anchor.discover()
            for code in codes:
                cur = disc.currency(code)
                if cur is not None:
                    issuers[code] = cur.issuer
        except AnchorError as e:
            error = e.message
            log.warning("wallet: anchor discovery failed, using asset rows: %s", e.message)
    missing = [c for c in codes if c not in issuers]
    if missing:
        rows = (
            await db.execute(
                select(Asset).where(
                    Asset.network == settings.stellar_network,
                    Asset.is_active.is_(True),
                    Asset.code.in_([display_code(c) for c in missing]),
                    Asset.issuer.is_not(None),
                )
            )
        ).scalars().all()
        for a in rows:
            issuers.setdefault(anchor_service.normalize_asset_code(a.code), a.issuer)
    out: list[tuple[str, str | None]] = []
    for code in codes:
        if code == NATIVE:
            out.append((NATIVE, None))
        elif code in issuers and issuers[code]:
            out.append((code, issuers[code]))
    return out, error


# --- balances ----------------------------------------------------------------------------------------------


async def _classic_account(horizon: Any, address: str) -> AccountInfo | None:
    if horizon is None or not is_g_account(address):
        return None
    return await horizon.get_account(address)


async def collect_balances(
    db: AsyncSession, settings: Settings, soroban: Any, account: AccountInfo | None, address: str, assets: list[Asset], anchor_codes: set[str]
) -> list[WalletBalanceOut]:
    by_canonical = {a.canonical: a for a in assets}
    out: list[WalletBalanceOut] = []
    seen: set[str] = set()
    # 1. classic balances present on the account (native + trustlines), allow-listed or not
    if account is not None:
        for b in account.balances:
            canonical = b.asset.canonical
            asset = by_canonical.get(canonical)
            seen.add(canonical)
            out.append(
                WalletBalanceOut(
                    asset=asset_brief(asset) if asset else None,
                    code=b.asset.code,
                    issuer=b.asset.issuer,
                    contract_id=asset.contract_id if asset else None,
                    balance=quantize(b.balance),
                    available=quantize(max(b.available, Decimal("0"))),
                    limit=quantize(b.limit) if b.limit is not None else None,
                    source="horizon",
                    is_anchor_asset=anchor_service.normalize_asset_code(canonical if b.asset.is_native else b.asset.code) in anchor_codes,
                    is_base_allowed=bool(asset and asset.is_base_allowed),
                )
            )
    # 2. allow-listed tokens the Horizon view cannot show: pure Soroban tokens, or everything for C... holders
    for asset in assets:
        if asset.canonical in seen:
            continue
        if asset.is_classic and account is not None:
            continue  # classic asset without a trustline: not held (reported under missing_trustlines)
        if account is None and is_g_account(address):
            continue  # unfunded G account: nothing to look up on either rail
        if soroban is None:
            continue
        try:
            raw = int(await soroban.token_balance(asset.contract_id, address))
        except StellarError as e:
            log.warning("wallet: token_balance(%s) failed: %s", asset.code, e.message)
            continue
        except Exception as e:  # noqa: BLE001 - RPC hiccup must not break the wallet screen
            log.warning("wallet: token_balance(%s) failed: %s", asset.code, e)
            continue
        if raw <= 0 and not asset.is_base_allowed:
            continue
        bal = money.from_stroops(raw, asset.decimals)
        out.append(
            WalletBalanceOut(
                asset=asset_brief(asset),
                code=asset.code,
                issuer=asset.issuer,
                contract_id=asset.contract_id,
                balance=bal,
                available=bal,
                source="soroban",
                is_anchor_asset=anchor_service.normalize_asset_code(asset.code) in anchor_codes and asset.is_classic,
                is_base_allowed=asset.is_base_allowed,
            )
        )
    out.sort(key=lambda b: (0 if b.code == "XLM" and b.issuer is None else 1, not b.is_base_allowed, b.code))
    return out


def _apply_tl(balances: list[WalletBalanceOut], conv: TlConverter | None) -> Decimal | None:
    if conv is None:
        return None
    total = Decimal("0")
    known = False
    for b in balances:
        b.value_try = conv.to_try(b.balance, b.code)
        if b.value_try is not None:
            total += b.value_try
            known = True
    return total if known else None


# --- missing trustlines ---------------------------------------------------------------------------------------


def missing_trustlines(
    account: AccountInfo | None, anchor_refs: list[tuple[str, str | None]], assets: list[Asset]
) -> list[MissingTrustlineOut]:
    by_canonical = {a.canonical: a for a in assets}
    out: list[MissingTrustlineOut] = []
    for code, issuer in anchor_refs:
        if code == NATIVE or not issuer:
            continue
        ref = AssetRef(code, issuer)
        if account is not None and account.has_trustline(ref):
            continue
        row = by_canonical.get(ref.canonical)
        out.append(
            MissingTrustlineOut(
                asset_code=code, issuer=issuer, asset_id=row.id if row else None,
                reason="anchor_deposit" if account is not None else "account_not_funded",
            )
        )
    return out


# --- movements ------------------------------------------------------------------------------------------------


async def _payments(horizon: Any, address: str) -> list[PaymentRecord]:
    """All payment ops of the account (Horizon pages ascending; bounded)."""
    if horizon is None or not is_g_account(address):
        return []
    records: list[PaymentRecord] = []
    cursor: str | None = None
    for _ in range(MAX_PAYMENT_PAGES):
        page, next_cursor = await horizon.fetch_payments(address, cursor, PAYMENT_PAGE)
        records.extend(page)
        if len(page) < PAYMENT_PAGE or not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
    return records


def _payment_movement(rec: PaymentRecord, address: str, conv: TlConverter | None) -> MovementOut:
    incoming = rec.destination == address
    if rec.op_type == "create_account":
        kind, title = "create_account", "Account created" if incoming else "Account creation"
    else:
        kind, title = ("payment_in", "Payment in") if incoming else ("payment_out", "Payment out")
    return MovementOut(
        id=f"pay:{rec.op_id or rec.tx_hash}",
        kind=kind,  # type: ignore[arg-type]
        direction="in" if incoming else "out",
        title=title,
        asset_code=rec.asset.code,
        asset_issuer=rec.asset.issuer,
        amount=quantize(rec.amount),
        value_try=conv.to_try(rec.amount, rec.asset.code) if conv else None,
        counterparty=rec.source_account if incoming else rec.destination,
        memo=rec.memo,
        tx_hash=rec.tx_hash or None,
        status="success",
        at=_parse_iso(rec.created_at),
        ref_type="payment",
        ref_id=rec.tx_hash or None,
    )


def _agreement_movements(rows: list[Agreement], user: User, conv: TlConverter | None) -> list[MovementOut]:
    out: list[MovementOut] = []
    for ag in rows:
        code = ag.base_asset.code
        issuer = ag.base_asset.issuer
        role = UserRole.customer if ag.customer_id == user.id else UserRole.trader
        escrow_tx = ag.created_tx if ag.proposer_role is UserRole.customer else ag.activate_tx
        funded = ag.status in (AgreementStatus.funded, AgreementStatus.active, AgreementStatus.settled) or (
            ag.status is AgreementStatus.cancelled and escrow_tx is not None
        )
        if role is UserRole.customer and funded and escrow_tx:
            out.append(
                MovementOut(
                    id=f"ag:{ag.id}:escrow", kind="agreement_escrow", direction="out", title="Capital locked in escrow",
                    asset_code=code, asset_issuer=issuer, amount=quantize(ag.principal),
                    value_try=conv.to_try(ag.principal, code) if conv else None, counterparty="vault", tx_hash=escrow_tx,
                    status=ag.status.value, at=ag.start_time or ag.created_at, ref_type="agreement", ref_id=str(ag.id),
                )
            )
        if ag.status is AgreementStatus.settled:
            amount = ag.customer_payout if role is UserRole.customer else ag.trader_fee
            if amount is not None and (amount > 0 or role is UserRole.customer):
                out.append(
                    MovementOut(
                        id=f"ag:{ag.id}:payout", kind="agreement_payout", direction="in",
                        title="Settlement payout" if role is UserRole.customer else "Commission",
                        asset_code=code, asset_issuer=issuer, amount=quantize(amount),
                        value_try=conv.to_try(amount, code) if conv else None, counterparty="vault", tx_hash=ag.settle_tx,
                        status=ag.status.value, at=ag.settled_at or ag.updated_at, ref_type="agreement", ref_id=str(ag.id),
                    )
                )
        elif ag.status is AgreementStatus.cancelled and role is UserRole.customer and escrow_tx:
            out.append(
                MovementOut(
                    id=f"ag:{ag.id}:refund", kind="agreement_refund", direction="in", title="Agreement cancelled — refund",
                    asset_code=code, asset_issuer=issuer, amount=quantize(ag.principal),
                    value_try=conv.to_try(ag.principal, code) if conv else None, counterparty="vault", tx_hash=ag.cancel_tx,
                    status=ag.status.value, at=ag.updated_at, ref_type="agreement", ref_id=str(ag.id),
                )
            )
    return out


def _anchor_movements(rows: list[AnchorTransaction], conv: TlConverter | None) -> list[MovementOut]:
    out: list[MovementOut] = []
    for tx in rows:
        deposit = tx.kind is AnchorTxKind.deposit
        amount = (tx.amount_out or tx.amount_in) if deposit else (tx.amount_in or tx.amount_out)
        code = display_code(tx.asset_code)
        out.append(
            MovementOut(
                id=f"anchor:{tx.id}", kind="anchor_deposit" if deposit else "anchor_withdraw",
                direction="in" if deposit else "out", title="Deposit (anchor)" if deposit else "Withdrawal (anchor)",
                asset_code=code, asset_issuer=tx.asset_issuer, amount=quantize(amount) if amount is not None else None,
                value_try=conv.to_try(amount, code) if (conv and amount is not None) else None,
                counterparty=tx.anchor_domain, memo=tx.withdraw_memo, tx_hash=tx.stellar_tx_hash,
                status=tx.status, at=tx.completed_at or tx.updated_at or tx.created_at, ref_type="anchor", ref_id=str(tx.id),
            )
        )
    return out


async def list_movements(
    db: AsyncSession, settings: Settings, horizon: Any, user: User, *, conv: TlConverter | None = None, limit: int = DEFAULT_MOVEMENTS
) -> list[MovementOut]:
    address = user.stellar_address
    try:
        payments = await _payments(horizon, address)
    except StellarError as e:
        log.warning("wallet: payments unavailable: %s", e.message)
        payments = []
    anchors = list(
        (
            await db.execute(
                select(AnchorTransaction).where(AnchorTransaction.user_id == user.id).order_by(AnchorTransaction.created_at.desc()).limit(200)
            )
        ).scalars().all()
    )
    anchor_hashes = {t.stellar_tx_hash for t in anchors if t.stellar_tx_hash}
    agreements = list(
        (
            await db.execute(
                select(Agreement).where(
                    or_(Agreement.customer_id == user.id, Agreement.trader_id == user.id),
                    Agreement.status.in_(
                        [AgreementStatus.funded, AgreementStatus.active, AgreementStatus.settled, AgreementStatus.cancelled]
                    ),
                )
            )
        ).scalars().all()
    )
    items = [_payment_movement(p, address, conv) for p in payments if not (p.tx_hash and p.tx_hash in anchor_hashes)]
    items += _agreement_movements(agreements, user, conv)
    items += _anchor_movements(anchors, conv)
    items.sort(key=lambda m: m.at, reverse=True)
    return items[: max(1, limit)]


# --- GET /wallet ------------------------------------------------------------------------------------------------------


async def get_wallet(
    db: AsyncSession,
    settings: Settings,
    soroban: Any,
    horizon: Any,
    user: User,
    *,
    anchor: AnchorClient | None = None,
    movements_limit: int = DEFAULT_MOVEMENTS,
) -> WalletOut:
    address = user.stellar_address
    assets = list(
        (await db.execute(select(Asset).where(Asset.network == settings.stellar_network, Asset.is_active.is_(True)))).scalars().all()
    )
    anchor_refs, _ = await anchor_asset_refs(db, settings, anchor)
    anchor_codes = {code for code, _ in anchor_refs}
    account = await _classic_account(horizon, address)
    balances = await collect_balances(db, settings, soroban, account, address, assets, anchor_codes)
    codes = {b.code for b in balances} | {a.code for a in assets}
    conv = await tl_converter(db, settings, soroban, codes)
    total_try = _apply_tl(balances, conv)
    movements = await list_movements(db, settings, horizon, user, conv=conv, limit=movements_limit)
    fx_out = WalletFxOut(rate=quantize(conv.rate.rate), source=conv.rate.source, stale=conv.rate.stale) if conv and conv.rate else None
    return WalletOut(
        address=address,
        network=settings.stellar_network,
        funded=account is not None or (not is_g_account(address) and bool(balances)),
        balances=balances,
        total_try=total_try,
        fx=fx_out,
        missing_trustlines=missing_trustlines(account, anchor_refs, assets) if settings.anchor_enabled else [],
        movements=movements,
        anchor_enabled=settings.anchor_enabled,
        anchor_home_domain=settings.anchor_home_domain,
        friendbot_url=_friendbot_link(settings, address) if account is None else None,
        updated_at=now_utc(),
    )


def _friendbot_link(settings: Settings, address: str) -> str | None:
    base = settings.effective_friendbot_url
    if not base or not settings.is_testnet:
        return None
    return f"{base}?{urlencode({'addr': address})}"


# --- GET /wallet/deposit-info -------------------------------------------------------------------------------------------


async def deposit_info(db: AsyncSession, settings: Settings, horizon: Any, user: User, *, anchor: AnchorClient | None) -> DepositInfoOut:
    address = user.stellar_address
    account = await _classic_account(horizon, address)
    funded: bool | None = None if not is_g_account(address) else account is not None
    anchor_assets: list[DepositInfoAssetOut] = []
    anchor_error: str | None = None
    if settings.anchor_enabled and anchor is not None:
        try:
            disc = await anchor.discover()
            info = await anchor.info()
            for a in anchor_service.anchor_assets(settings, disc, info):
                has = None
                if account is not None:
                    has = True if a.code == NATIVE else account.has_trustline(AssetRef(a.code, a.issuer or ""))
                anchor_assets.append(
                    DepositInfoAssetOut(
                        code=a.code, display_code=a.display_code, issuer=a.issuer, needs_trustline=a.needs_trustline,
                        has_trustline=has, deposit_enabled=a.deposit_enabled, deposit_min=a.deposit_min, deposit_max=a.deposit_max,
                    )
                )
        except AnchorError as e:
            anchor_error = e.message
    instructions = [
        "This is your Stellar address. Send XLM or any asset you hold a trustline for to it.",
        "To deposit with TRY, go to Wallet → Deposit; the anchor issues the asset to this address.",
    ]
    if funded is False and settings.is_testnet:
        instructions.insert(0, "The account is not on the network yet — fund it for free with friendbot on testnet.")
    # Hangi protokol: SEP-24'te anchor kendi sayfasını açar, SEP-6'da talimatı
    # uygulama gösterir. Cüzdan ekranı kullanıcıya doğru şeyi söyleyebilsin diye.
    anchor_protocol: str | None = None
    if settings.anchor_enabled and anchor is not None and anchor_error is None:
        try:
            anchor_protocol = await anchor.protocol()
        except Exception as e:  # keşif hatası yatırma bilgisini düşürmemeli
            log.warning("anchor protocol unknown: %s", e)

    if any(a.needs_trustline and a.has_trustline is False for a in anchor_assets):
        instructions.append("Add a trustline for assets like USDC first, otherwise the deposit waits.")
    return DepositInfoOut(
        address=address,
        network=settings.stellar_network,
        network_passphrase=settings.network_passphrase,
        funded=funded,
        friendbot_url=_friendbot_link(settings, address) if funded is not True else None,
        pay_uri=f"web+stellar:pay?{urlencode({'destination': address, 'network_passphrase': settings.network_passphrase})}",
        instructions=instructions,
        anchor_enabled=settings.anchor_enabled,
        anchor_home_domain=settings.anchor_home_domain,
        anchor_assets=anchor_assets,
        anchor_protocol=anchor_protocol,
        anchor_error=anchor_error,
    )


# --- unsigned classic transactions ------------------------------------------------------------------------------------------


async def _resolve_asset(
    db: AsyncSession, settings: Settings, *, asset_id: uuid.UUID | None, code: str | None, issuer: str | None
) -> tuple[str, str | None, Asset | None]:
    """(classic code, issuer, row|None). Native = ('XLM', None)."""
    if asset_id is not None:
        row = await db.get(Asset, asset_id)
        if row is None or row.network != settings.stellar_network or not row.is_active:
            raise NotFoundError("Asset not found", code="asset_not_found")
        if not row.is_classic:
            raise ValidationError(
                f"{row.code} is a pure Soroban token; classic payments need a Stellar asset", code="asset_not_classic"
            )
        return ("XLM", None, row) if row.is_native else (row.code, row.issuer, row)
    norm = anchor_service.normalize_asset_code(code or "")
    if norm == NATIVE:
        row = (
            await db.execute(select(Asset).where(Asset.network == settings.stellar_network, Asset.issuer.is_(None), Asset.code == "XLM"))
        ).scalars().first()
        return "XLM", None, row
    if not issuer:
        raise ValidationError(f"{norm} needs an issuer", code="asset_issuer_required")
    if not is_g_account(issuer):
        raise ValidationError("invalid issuer", code="invalid_issuer")
    row = (
        await db.execute(select(Asset).where(Asset.network == settings.stellar_network, Asset.code == norm, Asset.issuer == issuer))
    ).scalars().first()
    return norm, issuer, row


async def build_payment(db: AsyncSession, settings: Settings, soroban: Any, user: User, body: WalletPaymentIn) -> UnsignedTxOut:
    """``POST /wallet/tx/payment``: unsigned payment (or create_account for XLM to a new account)."""
    if body.to == user.stellar_address:
        raise ValidationError("destination must differ from your own address", code="invalid_destination")
    code, issuer, row = await _resolve_asset(db, settings, asset_id=body.asset_id, code=body.asset_code, issuer=body.asset_issuer)
    memo = body.memo if body.memo not in (None, "") else None
    unsigned: UnsignedTx = await soroban.build_payment(
        user.stellar_address, body.to, code, issuer, body.amount, memo=memo, memo_type=body.memo_type if memo else None
    )
    pending: PendingTransaction = await record_pending(
        db, user, PendingTxKind.payment, None, unsigned,
        payload={"purpose": "wallet_payment", "asset_id": str(row.id) if row else None, "destination": body.to},
    )
    return unsigned_out(pending, unsigned, user.stellar_address)


async def build_trustline(db: AsyncSession, settings: Settings, soroban: Any, user: User, body: TrustlineIn) -> UnsignedTxOut:
    """``POST /wallet/tx/trustline``: unsigned ``change_trust`` so the anchor can deliver an issued asset."""
    code, issuer, row = await _resolve_asset(db, settings, asset_id=body.asset_id, code=body.asset_code, issuer=body.issuer)
    if issuer is None:
        raise ValidationError("native XLM needs no trustline", code="invalid_asset")
    unsigned: UnsignedTx = await soroban.build_change_trust(user.stellar_address, code, issuer, limit=body.limit)
    pending: PendingTransaction = await record_pending(
        db, user, PendingTxKind.trustline, None, unsigned,
        payload={"purpose": "trustline", "asset_id": str(row.id) if row else None, "asset_code": code, "issuer": issuer},
    )
    return unsigned_out(pending, unsigned, user.stellar_address)


__all__ = [
    "anchor_asset_refs",
    "build_payment",
    "build_trustline",
    "collect_balances",
    "deposit_info",
    "get_wallet",
    "list_movements",
    "missing_trustlines",
]
