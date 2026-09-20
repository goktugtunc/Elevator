"""Import every model so Base.metadata is complete (Alembic autogenerate + relationship resolution)."""
from app.db.base import Base
from app.models.agreement import Agreement, AgreementBalance, AgreementValueSnapshot
from app.models.anchor import AnchorSession, AnchorTransaction
from app.models.asset import Asset
from app.models.auth_nonce import AuthNonce
from app.models.enums import (
    AgreementStatus,
    AnchorTxKind,
    AnchorTxStatus,
    InteractionAction,
    InteractionTargetType,
    ListingKind,
    ListingStatus,
    MarketCategory,
    NotificationCategory,
    OfferDirection,
    OfferStatus,
    PendingTxKind,
    PendingTxStatus,
    RiskLevel,
    RiskProfile,
    UserRole,
)
from app.models.indexer_state import IndexerState
from app.models.interaction import Favorite, Follow, Interaction
from app.models.listing import Listing
from app.models.messaging import Conversation, Message
from app.models.notification import Notification
from app.models.offer import Offer
from app.models.pending_transaction import PendingTransaction
from app.models.rating import Rating
from app.models.trade import Trade
from app.models.user import User

__all__ = [
    "Base",
    # tables
    "Agreement",
    "AgreementBalance",
    "AgreementValueSnapshot",
    "AnchorSession",
    "AnchorTransaction",
    "Asset",
    "AuthNonce",
    "Conversation",
    "Favorite",
    "Follow",
    "IndexerState",
    "Interaction",
    "Listing",
    "Message",
    "Notification",
    "Offer",
    "PendingTransaction",
    "Rating",
    "Trade",
    "User",
    # enums
    "AgreementStatus",
    "AnchorTxKind",
    "AnchorTxStatus",
    "InteractionAction",
    "InteractionTargetType",
    "ListingKind",
    "ListingStatus",
    "MarketCategory",
    "NotificationCategory",
    "OfferDirection",
    "OfferStatus",
    "PendingTxKind",
    "PendingTxStatus",
    "RiskLevel",
    "RiskProfile",
    "UserRole",
]
