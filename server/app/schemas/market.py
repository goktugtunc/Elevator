"""Market data I/O models."""
from __future__ import annotations

from pydantic import BaseModel, Field


class CandleOut(BaseModel):
    """One OHLCV bar. Amounts are decimal strings, like every other amount in this API."""

    t: int = Field(description="bar start, unix ms")
    o: str
    h: str
    l: str
    c: str
    avg: str = Field(description="volume-weighted average — the reference used to clip outliers")
    v: str = Field(description="base asset volume")
    trades: int


class CandlesOut(BaseModel):
    pair: str
    range: str
    interval: str
    source: str
    candles: list[CandleOut] = Field(default_factory=list)
    last: str | None = None
    change_bps: int = 0
    median: str | None = None
