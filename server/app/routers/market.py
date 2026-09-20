"""Market data for the trade screen — Stellar DEX candles (DESIGN §4 "Charts")."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api_deps import CurrentUser, SettingsDep
from app.schemas.market import CandlesOut
from app.services import market as market_service

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/candles", response_model=CandlesOut)
async def candles(
    settings: SettingsDep,
    user: CurrentUser,
    pair: Annotated[str, Query(description="XLM-USDC")] = "XLM-USDC",
    range: Annotated[str, Query(alias="range", description="1d | 1w | 1m")] = "1d",
    interval: Annotated[str | None, Query(description="15m | 1h | 1d; omit for the range default")] = None,
) -> CandlesOut:
    """OHLCV candles for the pair, from the Stellar DEX on **mainnet**.

    Testnet's order book sits at a fake pegged rate, so it is useless for deciding a trade; mainnet
    is what the Soroswap pool we execute against actually tracks. Outlier highs/lows are clipped
    against the volume-weighted average — a single odd trade otherwise turns a candle into a spike.
    """
    return CandlesOut.model_validate(
        await market_service.candles(settings, pair=pair, range_=range, interval=interval)
    )
