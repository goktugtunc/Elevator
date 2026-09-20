"""Idempotent asset allow-list seed for `settings.stellar_network`. Run: python -m scripts.seed_assets

Rows are matched by (network, contract_id). Descriptive fields (code, issuer, name, category,
is_base_allowed, decimals) are refreshed on every run; the admin-controlled flags `is_active` and
`onchain_allowed` are never overwritten for existing rows.

SAC ids of classic assets are deterministic (sha256 over network id + asset) — verified with
`stellar contract id asset` / `stellar_sdk.Asset.contract_id` (tests/test_models.py asserts them).
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.session import dispose_engine, get_session_factory
from app.models import Asset, MarketCategory

log = logging.getLogger("seed_assets")

# `key` is a stable handle for tests/scripts (codes are not unique: two USDC tokens on testnet).
SEED: dict[str, list[dict]] = {
    "testnet": [
        {
            "key": "XLM",
            "code": "XLM",
            "issuer": None,
            "contract_id": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
            "name": "Stellar Lumens",
            "category": MarketCategory.crypto,
            "is_base_allowed": True,
        },
        {
            # Circle testnet USDC (delivered by testanchor.stellar.org); no Soroswap liquidity on testnet
            "key": "USDC",
            "code": "USDC",
            "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            "contract_id": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            "name": "USD Coin (Circle testnet)",
            "category": MarketCategory.stable_fx,
            "is_base_allowed": True,
        },
        {
            # Soroswap testnet test token (pure Soroban token, has XLM liquidity)
            "key": "USDC_SOROSWAP",
            "code": "USDC",
            "issuer": None,
            "contract_id": "CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F",
            "name": "USDC (Soroswap test)",
            "category": MarketCategory.stable_fx,
            "is_base_allowed": True,
        },
        {
            "key": "EURC_SOROSWAP",
            "code": "EURC",
            "issuer": None,
            "contract_id": "CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT",
            "name": "EURC (Soroswap test)",
            "category": MarketCategory.stable_fx,
            "is_base_allowed": False,
        },
        {
            # SDF test anchor reference token
            "key": "SRT",
            "code": "SRT",
            "issuer": "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B",
            "contract_id": "CBZVLMD5DBKIFSVU23WAVMJD25IRUBWCVAXGURPUPMB2CUNFBQN742UV",
            "name": "Stellar Reference Token",
            "category": MarketCategory.crypto,
            "is_base_allowed": False,
        },
    ],
    "public": [
        {
            "key": "XLM",
            "code": "XLM",
            "issuer": None,
            "contract_id": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
            "name": "Stellar Lumens",
            "category": MarketCategory.crypto,
            "is_base_allowed": True,
        },
        {
            "key": "USDC",
            "code": "USDC",
            "issuer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            "contract_id": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
            "name": "USD Coin (Circle)",
            "category": MarketCategory.stable_fx,
            "is_base_allowed": True,
        },
        {
            "key": "EURC",
            "code": "EURC",
            "issuer": "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
            "contract_id": "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
            "name": "Euro Coin (Circle)",
            "category": MarketCategory.stable_fx,
            "is_base_allowed": False,
        },
    ],
}

_REFRESHED_FIELDS = ("code", "issuer", "name", "category", "is_base_allowed")


async def seed_network(db: AsyncSession, network: str) -> tuple[int, int]:
    """Insert missing rows / refresh descriptive fields for `network`. Flushes only (caller commits).
    Returns (created, updated)."""
    created = updated = 0
    for row in SEED[network]:
        existing = (
            await db.execute(select(Asset).where(Asset.network == network, Asset.contract_id == row["contract_id"]))
        ).scalar_one_or_none()
        if existing is None:
            data = {k: v for k, v in row.items() if k != "key"}
            db.add(Asset(network=network, decimals=7, is_active=True, onchain_allowed=False, **data))
            created += 1
            continue
        changed = False
        for f in _REFRESHED_FIELDS:
            if getattr(existing, f) != row[f]:
                setattr(existing, f, row[f])
                changed = True
        if changed:
            updated += 1
    await db.flush()
    return created, updated


async def seed() -> tuple[int, int]:
    """Seed the configured network and dispose the engine on the same event loop."""
    settings = get_settings()
    try:
        async with get_session_factory()() as db:
            result = await seed_network(db, settings.stellar_network)
            await db.commit()
    finally:
        await dispose_engine()
    return result


def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    created, updated = asyncio.run(seed())
    log.info("asset seed done (network=%s, created=%d, updated=%d)", settings.stellar_network, created, updated)


if __name__ == "__main__":
    main()
