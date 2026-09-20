"""Cüzdan endpoints (Figma 8c; DESIGN §2.3 Wallet, §3.2 trustlines)."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api_deps import DB, CurrentUser, HorizonDep, SettingsDep, SorobanDep
from app.schemas.tx import UnsignedTxOut
from app.schemas.wallet import DepositInfoOut, TrustlineIn, WalletOut, WalletPaymentIn
from app.services import wallet as wallet_service
from app.services.anchor import AnchorClient, get_anchor_client

router = APIRouter(prefix="/wallet", tags=["wallet"])

AnchorDep = Depends(get_anchor_client)


@router.get("", response_model=WalletOut)
async def get_wallet(
    db: DB,
    settings: SettingsDep,
    user: CurrentUser,
    movements: Annotated[int, Query(ge=1, le=100, description="number of recent movements")] = 20,
    soroban=SorobanDep,
    horizon=HorizonDep,
    anchor: AnchorClient = AnchorDep,
) -> WalletOut:
    """Balances of the caller's address (classic via Horizon, allow-listed Soroban tokens via RPC) with TL
    equivalents, trustlines still missing for the anchor's assets and the recent movements (payments +
    agreement escrow/payout/refund + anchor deposits/withdrawals)."""
    return await wallet_service.get_wallet(db, settings, soroban, horizon, user, anchor=anchor, movements_limit=movements)


@router.get("/deposit-info", response_model=DepositInfoOut)
async def deposit_info(
    db: DB, settings: SettingsDep, user: CurrentUser, horizon=HorizonDep, anchor: AnchorClient = AnchorDep
) -> DepositInfoOut:
    """Address, SEP-7 pay URI, friendbot link (testnet), anchor assets with limits + trustline status."""
    return await wallet_service.deposit_info(db, settings, horizon, user, anchor=anchor)


@router.post("/tx/payment", response_model=UnsignedTxOut)
async def payment(body: WalletPaymentIn, db: DB, settings: SettingsDep, user: CurrentUser, soroban=SorobanDep) -> UnsignedTxOut:
    """Unsigned classic payment from the caller to `to` (XLM to a new account becomes create_account).
    Sign it in the app, then POST /tx/submit."""
    return await wallet_service.build_payment(db, settings, soroban, user, body)


@router.post("/tx/trustline", response_model=UnsignedTxOut)
async def trustline(body: TrustlineIn, db: DB, settings: SettingsDep, user: CurrentUser, soroban=SorobanDep) -> UnsignedTxOut:
    """Unsigned `change_trust` so the account can receive an issued asset (needed before a non-native
    anchor deposit). Sign it in the app, then POST /tx/submit."""
    return await wallet_service.build_trustline(db, settings, soroban, user, body)


__all__ = ["router"]
