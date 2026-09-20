"""Classic Stellar (Horizon) gateway: accounts, balances, trustlines, payments history, friendbot,
classic transaction submission. Adapted from ``_parked`` (pool-signing paths removed: the backend never
holds user keys; DESIGN §2.4).

Every SDK exception is mapped to ``app.core.errors.StellarError`` (Horizon result codes end up in
``details["result_codes"]``).
"""
from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Any

import httpx
from stellar_sdk import Account, AiohttpClient, ServerAsync, TransactionBuilder, TransactionEnvelope
from stellar_sdk.exceptions import (
    BadRequestError,
    BadResponseError,
    BaseHorizonError,
    BaseRequestError,
    Ed25519SecretSeedInvalidError,
    SdkError,
)
from stellar_sdk.exceptions import ConnectionError as SdkConnectionError
from stellar_sdk.exceptions import NotFoundError as HorizonNotFoundError

from app.core.config import Settings
from app.core.errors import StellarError
from app.services.stellar.types import (
    AccountInfo,
    AccountNotFoundError,
    AccountSigners,
    AssetRef,
    Balance,
    PaymentRecord,
    SubmitResult,
    TxRejectedError,
    UnsignedTx,
)
from app.services.stellar.xdr_utils import (
    amount_str,
    apply_memo,
    asset_ref_from_horizon,
    check_text_memo,
    parse_payment_envelope,
    to_sdk_asset,
)

log = logging.getLogger(__name__)

PAYMENT_OP_TYPES = frozenset(
    {"payment", "path_payment_strict_send", "path_payment_strict_receive", "create_account"}
)
HORIZON_MAX_PAGE = 200
REQUEST_TIMEOUT = 15
POST_TIMEOUT = 40
FRIENDBOT_TIMEOUT = 60.0


# --- error mapping -------------------------------------------------------------------------


def _horizon_details(e: BaseHorizonError) -> dict[str, Any]:
    details: dict[str, Any] = {"status": e.status}
    if e.title:
        details["title"] = e.title
    if e.detail:
        details["detail"] = e.detail
    extras = e.extras or {}
    if extras.get("result_codes"):
        details["result_codes"] = extras["result_codes"]
    if extras.get("result_xdr"):
        details["result_xdr"] = extras["result_xdr"]
    if extras.get("hash"):
        details["hash"] = extras["hash"]
    return details


def wrap_sdk_error(e: Exception, context: str) -> StellarError:
    """Translate any stellar_sdk / network exception into a StellarError (idempotent for StellarError)."""
    if isinstance(e, StellarError):
        return e
    if isinstance(e, BadRequestError):
        details = _horizon_details(e)
        codes = details.get("result_codes")
        if codes:
            return TxRejectedError(f"{context}: tx failed: {codes}", details=details)
        msg = " ".join(x for x in (e.title, e.detail) if x) or e.message[:300]
        return StellarError(f"{context}: Horizon rejected the request: {msg}", code="horizon_bad_request", details=details)
    if isinstance(e, HorizonNotFoundError):
        return StellarError(f"{context}: resource not found on Horizon", code="horizon_not_found", details=_horizon_details(e))
    if isinstance(e, BadResponseError):
        return StellarError(
            f"{context}: Horizon error {e.status}: {e.title or e.detail or ''}".rstrip(": "),
            code="horizon_error",
            details=_horizon_details(e),
        )
    if isinstance(e, BaseHorizonError):
        return StellarError(f"{context}: Horizon error {e.status}", code="horizon_error", details=_horizon_details(e))
    if isinstance(e, SdkConnectionError | TimeoutError | asyncio.TimeoutError):
        return StellarError(f"{context}: cannot reach Horizon: {e}", code="horizon_unreachable")
    if isinstance(e, Ed25519SecretSeedInvalidError):
        return StellarError(f"{context}: invalid Stellar secret seed", code="invalid_secret")
    if isinstance(e, BaseRequestError | SdkError | ValueError):
        return StellarError(f"{context}: {type(e).__name__}: {e}", code="stellar_error")
    return StellarError(f"{context}: {type(e).__name__}: {e}", code="stellar_error")


def result_codes_of(e: StellarError) -> dict[str, Any]:
    codes = e.details.get("result_codes") if e.details else None
    return codes if isinstance(codes, dict) else {}


# --- response mapping ----------------------------------------------------------------------


def _decimal(value: Any, default: str = "0") -> Decimal:
    if value is None or value == "":
        return Decimal(default)
    return Decimal(str(value))


def account_info_from_horizon(data: dict[str, Any]) -> AccountInfo:
    balances: list[Balance] = []
    for b in data.get("balances", []):
        if b.get("asset_type") == "liquidity_pool_shares":
            continue
        balances.append(
            Balance(
                asset=asset_ref_from_horizon(b),
                balance=_decimal(b.get("balance")),
                selling_liabilities=_decimal(b.get("selling_liabilities")),
                buying_liabilities=_decimal(b.get("buying_liabilities")),
                limit=_decimal(b["limit"]) if b.get("limit") else None,
            )
        )
    return AccountInfo(
        account_id=data["account_id"],
        sequence=int(data["sequence"]),
        balances=balances,
        subentry_count=int(data.get("subentry_count") or 0),
        num_sponsoring=int(data.get("num_sponsoring") or 0),
        num_sponsored=int(data.get("num_sponsored") or 0),
    )


def account_signers_from_horizon(data: dict[str, Any]) -> AccountSigners:
    signers = [
        (s["key"], int(s.get("weight") or 0))
        for s in data.get("signers", [])
        if s.get("type", "ed25519_public_key") == "ed25519_public_key" and s.get("key")
    ]
    th = data.get("thresholds") or {}
    return AccountSigners(
        account_id=data["account_id"],
        signers=signers,
        low_threshold=int(th.get("low_threshold") or 0),
        med_threshold=int(th.get("med_threshold") or 0),
        high_threshold=int(th.get("high_threshold") or 0),
    )


def submit_result_from_horizon(data: dict[str, Any]) -> SubmitResult:
    return SubmitResult(
        hash=str(data.get("hash") or data.get("id") or ""),
        ledger=int(data.get("ledger") or 0),
        successful=bool(data.get("successful", True)),
        fee_charged_stroops=int(data.get("fee_charged") or 0),
        result_xdr=str(data.get("result_xdr") or ""),
        envelope_xdr=str(data.get("envelope_xdr") or ""),
    )


def payment_record_from_horizon(rec: dict[str, Any]) -> PaymentRecord | None:
    """Map one /payments record (joined with its transaction). None for op types we do not track."""
    op_type = rec.get("type")
    if op_type not in PAYMENT_OP_TYPES or rec.get("transaction_successful") is False:
        return None
    tx = rec.get("transaction") or {}
    memo_type = tx.get("memo_type")
    memo = tx.get("memo") if memo_type == "text" else None
    if op_type == "create_account":
        asset = AssetRef.native()
        amount = _decimal(rec.get("starting_balance"))
        destination = rec["account"]
        source = rec.get("funder") or rec.get("source_account") or ""
    else:
        asset = asset_ref_from_horizon(rec)
        amount = _decimal(rec.get("amount"))
        destination = rec["to"]
        source = rec.get("from") or rec.get("source_account") or ""
    return PaymentRecord(
        op_id=str(rec.get("id") or ""),
        paging_token=str(rec.get("paging_token") or ""),
        tx_hash=str(rec.get("transaction_hash") or tx.get("hash") or ""),
        source_account=source,
        destination=destination,
        asset=asset,
        amount=amount,
        memo=memo,
        memo_type=memo_type,
        created_at=str(rec.get("created_at") or tx.get("created_at") or ""),
        op_type=op_type,
    )


# --- gateway -------------------------------------------------------------------------------


class HorizonGateway:
    """Real Horizon via stellar_sdk ``ServerAsync`` + ``AiohttpClient``."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.network_passphrase = settings.network_passphrase
        self.horizon_url = settings.effective_horizon_url
        self._server: ServerAsync | None = None
        self._server_loop: asyncio.AbstractEventLoop | None = None

    # --- infrastructure ---------------------------------------------------------------------

    @property
    def server(self) -> ServerAsync:
        """ServerAsync bound to the running loop (aiohttp sessions are loop-bound)."""
        loop = asyncio.get_running_loop()
        if self._server is None or self._server_loop is not loop:
            self._server = ServerAsync(
                self.horizon_url, client=AiohttpClient(request_timeout=REQUEST_TIMEOUT, post_timeout=POST_TIMEOUT)
            )
            self._server_loop = loop
        return self._server

    async def close(self) -> None:
        if self._server is not None:
            try:
                await self._server.close()
            except Exception:  # pragma: no cover - best effort
                log.debug("error closing Horizon client", exc_info=True)
        self._server = None
        self._server_loop = None

    async def horizon_health(self) -> dict[str, Any]:
        """Horizon root document subset (for GET /health/stellar)."""
        try:
            root = await self.server.root().call()
        except Exception as e:
            raise wrap_sdk_error(e, "horizon_health") from e
        return {
            "horizon_url": self.horizon_url,
            "horizon_version": root.get("horizon_version"),
            "core_version": root.get("core_version"),
            "history_latest_ledger": root.get("history_latest_ledger"),
            "network_passphrase": root.get("network_passphrase"),
        }

    async def _load_account(self, account_id: str, context: str) -> Account:
        try:
            return await self.server.load_account(account_id)
        except HorizonNotFoundError as e:
            raise AccountNotFoundError(
                f"{context}: account {account_id} does not exist on the ledger", details={"account": account_id}
            ) from e
        except Exception as e:
            raise wrap_sdk_error(e, context) from e

    def _new_builder(self, account: Account) -> TransactionBuilder:
        return TransactionBuilder(
            source_account=account,
            network_passphrase=self.network_passphrase,
            base_fee=self._settings.base_fee_stroops,
        )

    # --- reads ------------------------------------------------------------------------------

    async def get_account(self, account_id: str) -> AccountInfo | None:
        """Account with all classic balances (native + trustlines). None if it does not exist."""
        try:
            data = await self.server.accounts().account_id(account_id).call()
        except HorizonNotFoundError:
            return None
        except Exception as e:
            raise wrap_sdk_error(e, "get_account") from e
        return account_info_from_horizon(data)

    async def account_exists(self, account_id: str) -> bool:
        return await self.get_account(account_id) is not None

    async def get_account_signers(self, account_id: str) -> AccountSigners | None:
        """Signers + thresholds (SEP-10 multisig fallback). None when the account does not exist."""
        try:
            data = await self.server.accounts().account_id(account_id).call()
        except HorizonNotFoundError:
            return None
        except Exception as e:
            raise wrap_sdk_error(e, "get_account_signers") from e
        return account_signers_from_horizon(data)

    async def has_trustline(self, account_id: str, asset_code: str, issuer: str | None) -> bool:
        """True when the account can receive the asset (native always; issued: trustline exists)."""
        ref = AssetRef.of(asset_code, issuer)
        if ref.is_native:
            return True
        info = await self.get_account(account_id)
        return info is not None and info.has_trustline(ref)

    async def fetch_payments(
        self, account_id: str, cursor: str | None, limit: int = 100
    ) -> tuple[list[PaymentRecord], str | None]:
        """Incoming + outgoing payment ops for an account, ascending from `cursor` (joined with tx memo)."""
        page = max(1, min(int(limit), HORIZON_MAX_PAGE))
        try:
            response = await (
                self.server.payments()
                .for_account(account_id)
                .cursor(cursor or "0")
                .order(desc=False)
                .limit(page)
                .join("transactions")
                .include_failed(False)
                .call()
            )
        except HorizonNotFoundError:
            return [], cursor
        except Exception as e:
            raise wrap_sdk_error(e, "fetch_payments") from e
        records: list[PaymentRecord] = []
        next_cursor = cursor
        for raw in response.get("_embedded", {}).get("records", []):
            next_cursor = str(raw.get("paging_token") or next_cursor)
            rec = payment_record_from_horizon(raw)
            if rec is not None:
                records.append(rec)
        return records, next_cursor

    async def get_transaction(self, tx_hash: str) -> SubmitResult | None:
        try:
            data = await self.server.transactions().transaction(tx_hash).call()
        except HorizonNotFoundError:
            return None
        except Exception as e:
            raise wrap_sdk_error(e, "get_transaction") from e
        return submit_result_from_horizon(data)

    # --- friendbot (testnet) ----------------------------------------------------------------

    async def fund_with_friendbot(self, account_id: str) -> None:
        url = self._settings.effective_friendbot_url
        if not self._settings.is_testnet or not url:
            raise StellarError("friendbot is only available on testnet", code="friendbot_unavailable")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(FRIENDBOT_TIMEOUT)) as client:
                response = await client.get(url, params={"addr": account_id})
        except httpx.HTTPError as e:
            raise StellarError(f"friendbot request failed: {e}", code="friendbot_failed") from e
        if response.status_code >= 400:
            body = response.text
            if "createAccountAlreadyExist" in body or "op_already_exists" in body:
                log.info("friendbot: account %s already exists", account_id)
                return
            raise StellarError(
                f"friendbot returned HTTP {response.status_code}",
                code="friendbot_failed",
                details={"status": response.status_code, "body": body[:500]},
            )
        log.info("friendbot funded %s", account_id)

    # --- unsigned tx for clients -------------------------------------------------------------

    async def build_payment_xdr(
        self,
        source_account_id: str,
        destination: str,
        asset: AssetRef,
        amount: Decimal,
        memo_text: str | None = None,
        *,
        memo: str | int | None = None,
        memo_type: str | None = None,
    ) -> str:
        """Unsigned single-payment envelope XDR for the *client* to sign (sequence loaded from Horizon)."""
        if memo_text is not None:
            memo, memo_type = check_text_memo(memo_text), "text"
        account = await self._load_account(source_account_id, "build_payment_xdr")
        try:
            builder = self._new_builder(account)
            builder.append_payment_op(destination, to_sdk_asset(asset), amount_str(amount))
            apply_memo(builder, memo, memo_type)
            builder.set_timeout(self._settings.tx_timeout_seconds)
            return builder.build().to_xdr()
        except (SdkError, ValueError) as e:
            raise wrap_sdk_error(e, "build_payment_xdr") from e

    async def build_payment(
        self,
        source_account_id: str,
        destination: str,
        asset: AssetRef,
        amount: Decimal,
        memo: str | int | None = None,
        memo_type: str | None = None,
    ) -> UnsignedTx:
        """Same as ``build_payment_xdr`` but wrapped as ``UnsignedTx`` (summary + hash + expiry)."""
        from datetime import UTC, datetime, timedelta

        xdr = await self.build_payment_xdr(source_account_id, destination, asset, amount, memo=memo, memo_type=memo_type)
        env = TransactionEnvelope.from_xdr(xdr, self.network_passphrase)
        return UnsignedTx(
            xdr=xdr,
            network_passphrase=self.network_passphrase,
            expires_at=datetime.now(UTC) + timedelta(seconds=self._settings.tx_timeout_seconds),
            summary={
                "kind": "payment",
                "source": source_account_id,
                "destination": destination,
                "asset": asset.canonical,
                "amount": amount_str(amount),
                "memo": memo,
                "memo_type": memo_type,
            },
            hash=env.hash_hex(),
            kind="payment",
        )

    def parse_payment_xdr(self, xdr: str) -> tuple[str, str, AssetRef, Decimal, str | None]:
        return parse_payment_envelope(xdr, self.network_passphrase)

    async def submit_xdr(self, signed_xdr: str) -> SubmitResult:
        """Submit a client-signed classic envelope through Horizon. StellarError (result codes) on failure."""
        if not isinstance(signed_xdr, str) or not signed_xdr.strip():
            raise StellarError("empty transaction XDR", code="invalid_xdr")
        try:
            response = await self.server.submit_transaction(signed_xdr.strip())
        except Exception as e:
            err = wrap_sdk_error(e, "submit_xdr")
            log.warning("submit_xdr failed: %s %s", err.message, err.details)
            raise err from e
        result = submit_result_from_horizon(response)
        if not result.successful:
            raise TxRejectedError(
                f"transaction {result.hash} was not successful",
                details={"hash": result.hash, "result_xdr": result.result_xdr},
            )
        log.info("submit_xdr: tx %s applied in ledger %s (fee %d stroops)", result.hash, result.ledger, result.fee_charged_stroops)
        return result


__all__ = [
    "HorizonGateway",
    "account_info_from_horizon",
    "account_signers_from_horizon",
    "payment_record_from_horizon",
    "submit_result_from_horizon",
    "wrap_sdk_error",
]
