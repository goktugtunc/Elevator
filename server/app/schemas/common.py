"""Shared Pydantic building blocks."""
from __future__ import annotations

import uuid
from decimal import ROUND_DOWN, Decimal
from typing import Annotated, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

STROOP = Decimal("0.0000001")


def quantize_amount(v: Decimal) -> Decimal:
    """Round DOWN to Stellar's 7 decimal places."""
    return Decimal(v).quantize(STROOP, rounding=ROUND_DOWN)


def _dec_to_str(v: Decimal) -> str:
    return format(Decimal(v), "f")


# Decimal serialized as a plain string ("12.5000000") so mobile clients never see float noise.
Amount = Annotated[Decimal, PlainSerializer(_dec_to_str, return_type=str, when_used="json")]
Units = Annotated[Decimal, PlainSerializer(_dec_to_str, return_type=str, when_used="json")]
Pct = Annotated[Decimal, PlainSerializer(_dec_to_str, return_type=str, when_used="json")]

# Input amount: positive, at most 7 decimals.
AmountIn = Annotated[Decimal, Field(gt=0, decimal_places=7, max_digits=30)]
PctIn = Annotated[Decimal, Field(ge=0, le=100, decimal_places=2, max_digits=5)]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class PageParams(BaseModel):
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class Message(BaseModel):
    message: str


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict = {}


class IdResponse(BaseModel):
    id: uuid.UUID
