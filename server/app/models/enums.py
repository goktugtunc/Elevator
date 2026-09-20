"""All domain enums (stored as VARCHAR via sa.Enum(native_enum=False)).

Names follow docs/DESIGN.md §2.1 / §3.2 exactly so every slice can code against them.
"""
from __future__ import annotations

from enum import StrEnum


class UserRole(StrEnum):
    customer = "customer"  # Müşteri: brings capital
    trader = "trader"


class RiskProfile(StrEnum):
    """Customer / listing risk profile (Figma 1f "risk profili")."""

    conservative = "conservative"
    balanced = "balanced"
    aggressive = "aggressive"


class RiskLevel(StrEnum):
    """Trader risk level (Figma 1g "risk seviyesi")."""

    low = "low"
    medium = "medium"
    high = "high"


class MarketCategory(StrEnum):
    """"Piyasalar" chips map to token categories (DESIGN §0)."""

    crypto = "crypto"
    stable_fx = "stable_fx"
    defi = "defi"


class ListingKind(StrEnum):
    capital = "capital"  # by customer: sermaye, süre, piyasa, maks. kayıp, risk profili
    service = "service"  # by trader: strateji, komisyon %, min sermaye, piyasalar, risk seviyesi


class ListingStatus(StrEnum):
    #: Capital listing whose reservation deposit is not confirmed yet; not public.
    draft = "draft"
    active = "active"
    paused = "paused"
    closed = "closed"


class InteractionTargetType(StrEnum):
    listing = "listing"
    user = "user"


class InteractionAction(StrEnum):
    pass_ = "pass"
    like = "like"
    save = "save"
    follow = "follow"
    view = "view"
    offer_request = "offer_request"


class OfferDirection(StrEnum):
    trader_to_customer = "trader_to_customer"  # "Teklif Ver" on a capital listing
    customer_to_trader = "customer_to_trader"  # "Teklif İste" on a trader / service listing


class OfferStatus(StrEnum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"
    withdrawn = "withdrawn"
    expired = "expired"


class AgreementStatus(StrEnum):
    """Off-chain mirror of the contract `Status` plus the pre/post-chain states."""

    draft = "draft"  # offer accepted, nothing on-chain yet
    proposed = "proposed"  # contract Status::Proposed (trader created, unfunded)
    funded = "funded"  # contract Status::Funded (customer created + escrowed)
    active = "active"  # contract Status::Active
    settled = "settled"  # contract Status::Settled
    cancelled = "cancelled"  # contract Status::Cancelled
    failed = "failed"  # on-chain creation failed / expired without being submitted

    @classmethod
    def from_onchain(cls, status: int) -> AgreementStatus:
        """Map the contract's `Status` discriminant (0..4) to the mirror status."""
        return _ONCHAIN_STATUS[status]


_ONCHAIN_STATUS = {
    0: AgreementStatus.proposed,
    1: AgreementStatus.funded,
    2: AgreementStatus.active,
    3: AgreementStatus.settled,
    4: AgreementStatus.cancelled,
}


class PendingTxKind(StrEnum):
    open = "open"
    propose = "propose"
    fund = "fund"
    accept = "accept"
    cancel = "cancel"
    trade = "trade"
    settle = "settle"
    payment = "payment"  # classic payment (wallet send / anchor withdraw leg)
    trustline = "trustline"  # change_trust before a non-native anchor deposit
    admin = "admin"  # set_token / set_paused / set_fees built for the admin key
    reserve = "reserve"  # customer locks a listing's capital in the vault
    release = "release"  # customer takes locked capital back out


class PendingTxStatus(StrEnum):
    built = "built"
    submitted = "submitted"
    success = "success"
    failed = "failed"
    expired = "expired"


class NotificationCategory(StrEnum):
    listing = "listing"
    offer = "offer"
    agreement = "agreement"
    wallet = "wallet"
    system = "system"


class AnchorTxKind(StrEnum):
    deposit = "deposit"
    withdraw = "withdraw"


class AnchorTxStatus(StrEnum):
    """SEP-24 transaction statuses we know about. `anchor_transactions.status` is stored as a plain
    string because anchors may introduce statuses; compare against these constants."""

    incomplete = "incomplete"
    pending_user_transfer_start = "pending_user_transfer_start"
    pending_user_transfer_complete = "pending_user_transfer_complete"
    pending_external = "pending_external"
    pending_anchor = "pending_anchor"
    pending_stellar = "pending_stellar"
    pending_trust = "pending_trust"
    pending_user = "pending_user"
    on_hold = "on_hold"
    completed = "completed"
    refunded = "refunded"
    expired = "expired"
    no_market = "no_market"
    too_small = "too_small"
    too_large = "too_large"
    error = "error"

    @property
    def is_terminal(self) -> bool:
        return self in _TERMINAL_ANCHOR_STATUSES


_TERMINAL_ANCHOR_STATUSES = frozenset(
    {
        AnchorTxStatus.completed,
        AnchorTxStatus.refunded,
        AnchorTxStatus.expired,
        AnchorTxStatus.no_market,
        AnchorTxStatus.too_small,
        AnchorTxStatus.too_large,
        AnchorTxStatus.error,
    }
)
