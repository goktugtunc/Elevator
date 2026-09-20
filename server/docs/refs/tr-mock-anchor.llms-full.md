# TR Mock Anchor — full reference
Base URL: https://tr-mock-anchor.fly.dev

A SEP-6 mock anchor for a Turkish TRY <-> USDC ramp on Stellar testnet, for builders integrating a TRY ramp before a production anchor exists.
One standard door: SEP-1 discovery, SEP-10 auth, SEP-6 deposit/withdraw, SEP-12 (simulated) KYC, SEP-38 quotes (TRY <-> USDC). The bank and KYC are simulated; the Stellar leg is real testnet USDC.
The whole integration handoff is two values: a home domain and an asset. Everything else is discovered from stellar.toml. Integrate once here, then move to any real SEP anchor by changing only the network and home domain.
Asset: USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5. Treasury: GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6.
Rates: USD/TRY from Reflector oracle + 50 bps spread (buy 49.029003, sell 48.541152). Amounts are decimal strings (TRY 2dp, USDC 7dp).
Limits: no per-transaction limits (testnet sandbox).

## SEP flow (end to end)
1. SEP-1: GET /.well-known/stellar.toml -> WEB_AUTH_ENDPOINT (/auth), TRANSFER_SERVER (/sep6), KYC_SERVER (/sep12), SIGNING_KEY, the USDC currency.
2. SEP-10: GET /auth?account=G... -> a challenge transaction; sign it with the user key; POST /auth {transaction} -> { token } (JWT). Send it as Authorization: Bearer <token>.
3. SEP-6 /sep6/info -> capabilities (deposit/withdraw USDC, fee, min/max).
4. SEP-6 deposit: GET /sep6/deposit?asset_code=USDC&account=G...&amount=... -> order id + bank instructions (IBAN + reference).
5. Simulate the bank (sandbox): POST /sep6/tx/{id}/simulate-bank-transfer {"amount":"..."} (or press the button on the transaction more_info_url). The anchor then pays real testnet USDC (a payment, or a claimable balance / pending_trust if the account has no USDC trustline).
6. Poll: GET /sep6/transaction?id={id} until status=completed.
7. SEP-6 withdraw: GET /sep6/withdraw?asset_code=USDC&type=bank_account&amount=... -> treasury account_id + memo (type id). Send that USDC on-chain with the memo; the anchor detects it and pays TRY (simulated FAST).
8. History: GET /sep6/transactions?asset_code=USDC and GET /sep6/transaction?id=|stellar_transaction_id=|external_transaction_id=.
SEP-12 KYC is simulated: a wallet user is auto-approved, no personal data is required or stored. SEP-38 gives firm TRY<->USDC quotes (/sep38/{info,prices,price,quote}); SEP-6 deposit-exchange/withdraw-exchange lock a quote_id.

## Statuses
SEP-6 deposit: pending_user_transfer_start -> pending_anchor -> completed. pending_trust while waiting for a USDC trustline (when the wallet did not opt into claimable balances). error on failure.
SEP-6 withdrawal: pending_user_transfer_start -> completed (once the USDC payment is detected and TRY is paid out).

## Errors
JSON {"error": "..."} on the SEP endpoints. SEP-10 verification failures return 400. Common SEP-6 errors: unsupported asset_code, amount below/above the limits, missing/!bank_account funding_method.

## What changes on mainnet
The SEP endpoints and your integration code do not change; you switch the network passphrase to public and the home domain to the real anchor. The one dependency: the mainnet anchor must implement SEP-6. Mainnet USDC issuer is GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN. Real bank transfer and real KYC replace the simulated ones. See /mainnet.
