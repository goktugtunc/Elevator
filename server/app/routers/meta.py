"""Infrastructure endpoints: health checks. Mounted without prefix.

The public client config lives in app.routers.config (`GET /api/v1/config`).
"""
from __future__ import annotations

from typing import Annotated

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_db

router = APIRouter(tags=["meta"])

DB = Annotated[AsyncSession, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.get("/health")
async def health(db: DB):
    try:
        await db.execute(text("SELECT 1"))
        db_status = "ok"
        code = 200
    except Exception:  # pragma: no cover - only when the database is down
        db_status = "error"
        code = 503
    return JSONResponse(status_code=code, content={"status": "ok" if code == 200 else "degraded", "db": db_status, "version": "0.1.0"})


@router.get("/health/stellar")
async def health_stellar(settings: SettingsDep):
    url = settings.effective_horizon_url
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
        return {
            "status": "ok",
            "network": settings.stellar_network,
            "horizon_url": url,
            "latest_ledger": data.get("history_latest_ledger"),
            "protocol_version": data.get("current_protocol_version"),
        }
    except Exception as e:  # pragma: no cover
        return JSONResponse(status_code=503, content={"status": "error", "horizon_url": url, "error": e.__class__.__name__})

