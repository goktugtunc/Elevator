"""assets — allow-listed tokens per network (SAC of a classic asset or a pure Soroban token)."""
from __future__ import annotations

from sqlalchemy import Boolean, Enum, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import MarketCategory


class Asset(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """`contract_id` is the C... address used on-chain (vault allow-list, router paths).

    `issuer` is NULL for native XLM *and* for pure Soroban tokens (e.g. Soroswap test USDC); use
    `is_native` / `is_classic` instead of testing `issuer` alone.
    """

    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("network", "contract_id", name="uq_assets_network_contract_id"),
        Index("ix_assets_network_code", "network", "code"),
    )

    network: Mapped[str] = mapped_column(String(16), nullable=False)  # testnet | public
    contract_id: Mapped[str] = mapped_column(String(56), nullable=False)  # C...
    code: Mapped[str] = mapped_column(String(12), nullable=False)
    issuer: Mapped[str | None] = mapped_column(String(56), nullable=True)
    decimals: Mapped[int] = mapped_column(Integer, nullable=False, default=7, server_default="7")
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    icon_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    category: Mapped[MarketCategory] = mapped_column(
        Enum(MarketCategory, native_enum=False, length=32), nullable=False, default=MarketCategory.crypto
    )
    is_base_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    # mirror of the vault contract allow-list (`is_token_allowed`), refreshed by admin sync
    onchain_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")

    @property
    def is_native(self) -> bool:
        return self.issuer is None and self.code == "XLM"

    @property
    def is_classic(self) -> bool:
        """True when the token has a Horizon-visible balance (native or classic issued asset)."""
        return self.is_native or self.issuer is not None

    @property
    def canonical(self) -> str:
        """Horizon-style asset identifier; pure Soroban tokens fall back to their contract id."""
        if self.is_native:
            return "native"
        if self.issuer is not None:
            return f"{self.code}:{self.issuer}"
        return self.contract_id

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Asset {self.network} {self.code} {self.contract_id[:6]}…>"
