"""Stellar integration layer: lazy singletons for the Soroban (RPC) and Horizon gateways.

Only `app.services.stellar.*` may import `stellar_sdk`. Routers take the gateways through
`app.api_deps.SorobanDep` / `HorizonDep`; tests swap in fakes with `set_soroban` / `set_horizon`.
The concrete classes live in `app.services.stellar.soroban.SorobanGateway` and
`app.services.stellar.horizon.HorizonGateway` and are imported lazily so importing this package
never touches the network or the SDK.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.services.stellar.horizon import HorizonGateway
    from app.services.stellar.soroban import SorobanGateway

_soroban: Any | None = None
_horizon: Any | None = None


def get_soroban() -> SorobanGateway:
    """Configured Soroban RPC gateway (contract reads, tx building, send/poll, events)."""
    global _soroban
    if _soroban is None:
        from app.core.config import get_settings
        from app.services.stellar.soroban import SorobanGateway

        _soroban = SorobanGateway(get_settings())
    return _soroban


def set_soroban(gw: Any | None) -> None:
    """Test hook: inject a FakeSorobanGateway (None resets to the lazy default)."""
    global _soroban
    _soroban = gw


def get_horizon() -> HorizonGateway:
    """Configured Horizon gateway (classic account/balances/payments)."""
    global _horizon
    if _horizon is None:
        from app.core.config import get_settings
        from app.services.stellar.horizon import HorizonGateway

        _horizon = HorizonGateway(get_settings())
    return _horizon


def set_horizon(gw: Any | None) -> None:
    """Test hook: inject a FakeHorizonGateway (None resets to the lazy default)."""
    global _horizon
    _horizon = gw


__all__ = ["get_soroban", "set_soroban", "get_horizon", "set_horizon"]
