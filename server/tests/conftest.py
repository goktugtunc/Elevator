"""Shared pytest fixtures (DESIGN §2.6, ARCHITECTURE §21).

* Session-scoped async engine on DATABASE_URL_TEST (create_all at start, drop_all at end); the app's
  `app.db.session` globals are pointed at it so `get_db` requests hit the test database.
* Every table is TRUNCATEd after each test.
* `client`: httpx.AsyncClient over the ASGI app (no lifespan). `db`: an AsyncSession (commit to make
  rows visible to API requests, which use their own sessions).
* `soroban` / `horizon`: install FakeSorobanGateway / FakeHorizonGateway via app.services.stellar.
* `make_user(role, **kw) -> (User, token)`, `auth_headers(token)`, `seed_assets -> {key: Asset}`.
Runs with APP_ENV=test (scripts/dev.sh test) and pytest-asyncio session loop scope (pyproject).
"""
from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from decimal import Decimal

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from stellar_sdk import Keypair

import app.db.session as db_session
from app.core.config import Settings, get_settings
from app.core.security import create_access_token
from app.db.base import Base
from app.models import Asset, RiskLevel, RiskProfile, User, UserRole
from app.services.stellar import set_horizon, set_soroban

MakeUser = Callable[..., Awaitable[tuple[User, str]]]


def _test_db_url(settings: Settings) -> str:
    url = os.environ.get("DATABASE_URL_TEST")
    if url:
        return url
    base, _, name = settings.database_url.rpartition("/")
    name = name.split("?", 1)[0]
    if not name.endswith("_test"):
        name = f"{name}_test"
    return f"{base}/{name}"


@pytest.fixture(scope="session")
def settings() -> Settings:
    return get_settings()


@pytest_asyncio.fixture(scope="session")
async def engine(settings: Settings) -> AsyncIterator[AsyncEngine]:
    url = _test_db_url(settings)
    assert url.endswith("_test"), f"refusing to run tests against a non-test database: {url}"
    eng = create_async_engine(url, poolclass=NullPool)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    # point the application at the test database
    db_session._engine = eng
    db_session._session_factory = async_sessionmaker(eng, expire_on_commit=False, autoflush=False)
    try:
        yield eng
    finally:
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await eng.dispose()
        db_session._engine = None
        db_session._session_factory = None


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables(engine: AsyncEngine) -> AsyncIterator[None]:
    """Truncate everything after each test (runs after the `db` session is closed)."""
    yield
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"))


@pytest_asyncio.fixture
async def db(engine: AsyncEngine, _clean_tables: None) -> AsyncIterator[AsyncSession]:
    async with db_session.get_session_factory()() as session:
        try:
            yield session
        finally:
            await session.rollback()


@pytest_asyncio.fixture
async def client(engine: AsyncEngine) -> AsyncIterator[AsyncClient]:
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# --- Stellar gateway fakes ---------------------------------------------------------------------


@pytest.fixture
def soroban():
    from app.services.stellar.fake import FakeSorobanGateway

    gw = FakeSorobanGateway()
    set_soroban(gw)
    try:
        yield gw
    finally:
        set_soroban(None)


@pytest.fixture
def horizon():
    from app.services.stellar.fake import FakeHorizonGateway

    gw = FakeHorizonGateway()
    set_horizon(gw)
    try:
        yield gw
    finally:
        set_horizon(None)


# --- users / auth ---------------------------------------------------------------------------


@pytest.fixture
def make_user(db: AsyncSession, settings: Settings) -> MakeUser:
    """`await make_user("trader", username="ali", commission_bps=1500)` -> (User, bearer token).

    Pass `keypair=Keypair` to control the wallet (e.g. to sign XDR in a test); otherwise a random
    keypair is generated and only its public key is stored. Rows are committed.
    """

    async def _make(role: UserRole | str = UserRole.customer, **kw) -> tuple[User, str]:
        role = UserRole(role)
        kp: Keypair = kw.pop("keypair", None) or Keypair.random()
        username = kw.pop("username", None) or f"{role.value[:4]}_{uuid.uuid4().hex[:8]}"
        data: dict = {
            "stellar_address": kp.public_key,
            "role": role,
            "username": username,
            "display_name": kw.pop("display_name", None) or username.replace("_", " ").title(),
            "markets": ["crypto", "stable_fx"],
        }
        if role is UserRole.customer:
            data.update(budget_amount=Decimal("1000"), risk_profile=RiskProfile.balanced)
        else:
            data.update(
                commission_bps=2000,
                min_capital=Decimal("100"),
                risk_level=RiskLevel.medium,
                strategy_summary="XLM/USDC momentum on Soroswap",
            )
        data.update(kw)
        user = User(**data)
        db.add(user)
        await db.commit()
        await db.refresh(user)
        token = create_access_token(settings, public_key=user.stellar_address, user_id=user.id, role=user.role.value)
        return user, token

    return _make


@pytest.fixture
def auth_headers() -> Callable[[str], dict[str, str]]:
    def _headers(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    return _headers


@pytest.fixture
def admin_headers(settings: Settings) -> dict[str, str]:
    return {"X-Admin-Key": settings.admin_key}


# --- assets ---------------------------------------------------------------------------------------


@pytest_asyncio.fixture
async def seed_assets(db: AsyncSession, settings: Settings) -> dict[str, Asset]:
    """Seed the configured network's allow-list; returns rows keyed by the seed `key`
    (testnet: XLM, USDC (Circle), USDC_SOROSWAP, EURC_SOROSWAP, SRT)."""
    from scripts.seed_assets import SEED, seed_network

    network = settings.stellar_network
    await seed_network(db, network)
    await db.commit()
    rows = (await db.execute(select(Asset).where(Asset.network == network))).scalars().all()
    by_contract = {a.contract_id: a for a in rows}
    return {row["key"]: by_contract[row["contract_id"]] for row in SEED[network]}
