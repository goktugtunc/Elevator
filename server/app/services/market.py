"""Market candles for the trade screen — Stellar DEX aggregates via Horizon.

Kaynak neden **mainnet**: testnet'in SDEX'inde XLM/USDC 1.05 civarında sabit,
sahte bir kurda duruyor; gerçek piyasa 0.19, bizim Soroswap havuzumuz 0.198.
Trader'ın gerçek grafiğe bakarak hareket etmesi isteniyorsa veri mainnet'ten
gelmeli — işlemin testnet'te yürümesi bunu değiştirmiyor.

Neden doğrudan Horizon'a değil de buradan: Horizon hız sınırlıyor ve her
kullanıcının her grafik açışı ayrı istek olurdu; aykırı değer temizliği de tek
yerde yapılmalı.
"""
from __future__ import annotations

import logging
import statistics
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx

from app.core.config import Settings
from app.core.errors import AppError, ValidationError

log = logging.getLogger(__name__)

HORIZON_MAINNET = "https://horizon.stellar.org"
HTTP_TIMEOUT = httpx.Timeout(10.0)

#: Horizon'un kabul ettiği çözünürlükler (ms). Başkası 400 döner.
INTERVALS: dict[str, int] = {
    "15m": 900_000,
    "1h": 3_600_000,
    "1d": 86_400_000,
}

#: Aralık -> (süre, varsayılan çözünürlük). Gün saatlik, hafta ve ay günlük.
RANGES: dict[str, tuple[timedelta, str]] = {
    "1d": (timedelta(days=1), "1h"),
    "1w": (timedelta(days=7), "1d"),
    "1m": (timedelta(days=30), "1d"),
}

#: İşlem çiftleri. Şimdilik tek çift; ihraççı mainnet Circle USDC.
PAIRS: dict[str, dict[str, str]] = {
    "XLM-USDC": {
        "base_asset_type": "native",
        "counter_asset_type": "credit_alphanum4",
        "counter_asset_code": "USDC",
        "counter_asset_issuer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    }
}

#: Aykırı fitil eşiği, sabit bir yüzde değil **pencerenin kendi dağılımından**
#: türetilir: her mumun uç değeri ortalamasından ne kadar sapmış, onun medyanı
#: alınır ve bunun birkaç katı tavan yapılır. Sabit bir eşik (ör. %25) piyasaya
#: göre ya çok gevşek kalıyor -- XLM/USDC'de gerçek sapma %1-2 iken tek bir
#: "1 XLM = 1 USDC" işlemi %25'e kadar geçiyordu -- ya da gerçek hareketi kırpıyor.
OUTLIER_FACTOR = Decimal("4")
#: Medyan sapma sıfıra yakınsa (çok durgun pencere) tabana oturur.
MIN_DEVIATION = Decimal("0.005")

#: Önbellek süresi: kapanmamış mum sık değişir, günlük mum değişmez.
CACHE_SECONDS: dict[str, int] = {"15m": 30, "1h": 60, "1d": 900}

_cache: dict[tuple[str, str, int], tuple[float, list[dict]]] = {}


class MarketUnavailableError(AppError):
    status_code = 503
    code = "market_unavailable"


@dataclass(frozen=True)
class Candle:
    t: int          # mum başlangıcı, ms
    o: Decimal
    h: Decimal
    l: Decimal
    c: Decimal
    avg: Decimal
    v: Decimal      # base (XLM) hacmi
    trades: int


def _deviation_cap(rows: list[dict]) -> Decimal:
    """Bu pencere için kabul edilebilir uç sapma oranı."""
    devs: list[Decimal] = []
    for r in rows:
        try:
            avg = Decimal(r["avg"])
            if avg <= 0:
                continue
            devs.append(max(Decimal(r["high"]) / avg - 1, 1 - Decimal(r["low"]) / avg))
        except (KeyError, ValueError, ArithmeticError):
            continue
    if not devs:
        return MIN_DEVIATION
    return max(Decimal(statistics.median(devs)) * OUTLIER_FACTOR, MIN_DEVIATION)


def _parse(raw: dict, cap: Decimal) -> Candle | None:
    try:
        avg = Decimal(raw["avg"])
        o, c = Decimal(raw["open"]), Decimal(raw["close"])
        hi, lo = avg * (1 + cap), avg * (1 - cap)
        return Candle(
            t=int(raw["timestamp"]),
            o=o,
            c=c,
            # open/close gerçek işlemlerdir, kırpılmaz; yalnız uçlar düzeltilir.
            h=max(min(Decimal(raw["high"]), hi), o, c),
            l=min(max(Decimal(raw["low"]), lo), o, c),
            avg=avg,
            v=Decimal(raw["base_volume"]),
            trades=int(raw["trade_count"]),
        )
    except (KeyError, ValueError, ArithmeticError) as e:
        log.warning("market: mum ayrıştırılamadı: %s", e)
        return None


async def candles(settings: Settings, *, pair: str, range_: str, interval: str | None = None) -> dict:
    if pair not in PAIRS:
        raise ValidationError(f"unknown pair {pair!r}", code="unknown_pair", details={"allowed": list(PAIRS)})
    if range_ not in RANGES:
        raise ValidationError(f"unknown range {range_!r}", code="unknown_range", details={"allowed": list(RANGES)})
    span, default_interval = RANGES[range_]
    interval = interval or default_interval
    if interval not in INTERVALS:
        raise ValidationError(
            f"unknown interval {interval!r}", code="unknown_interval", details={"allowed": list(INTERVALS)}
        )

    now = datetime.now(UTC)
    start = now - span
    # Mum başlangıcına hizala: aksi hâlde her istek yeni bir önbellek anahtarı olur.
    step = INTERVALS[interval]
    start_ms = (int(start.timestamp() * 1000) // step) * step
    key = (pair, interval, start_ms)

    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS[interval]:
        rows = hit[1]
    else:
        params = {
            **PAIRS[pair],
            "resolution": str(step),
            "start_time": str(start_ms),
            "end_time": str(int(now.timestamp() * 1000)),
            "order": "asc",
            "limit": "200",
        }
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
                res = await client.get(f"{HORIZON_MAINNET}/trade_aggregations", params=params)
                res.raise_for_status()
                rows = res.json().get("_embedded", {}).get("records", [])
        except Exception as e:  # noqa: BLE001 - kaynak dışarıda; bayat veri hiç yoktan iyidir
            if hit:
                log.warning("market: Horizon'a ulaşılamadı, önbellek kullanılıyor: %s", e)
                rows = hit[1]
            else:
                raise MarketUnavailableError(f"market data unavailable: {e}") from e
        else:
            _cache[key] = (time.monotonic(), rows)

    cap = _deviation_cap(rows)
    parsed = [c for c in (_parse(r, cap) for r in rows) if c is not None]
    closes = [c.c for c in parsed]
    change_bps = 0
    if len(closes) >= 2 and closes[0] > 0:
        change_bps = int((closes[-1] - closes[0]) / closes[0] * 10_000)

    return {
        "pair": pair,
        "range": range_,
        "interval": interval,
        "source": "stellar-dex-mainnet",
        "candles": [
            {
                "t": c.t,
                "o": str(c.o),
                "h": str(c.h),
                "l": str(c.l),
                "c": str(c.c),
                "avg": str(c.avg),
                "v": str(c.v),
                "trades": c.trades,
            }
            for c in parsed
        ],
        "last": str(closes[-1]) if closes else None,
        "change_bps": change_bps,
        "median": str(statistics.median(closes)) if closes else None,
    }
