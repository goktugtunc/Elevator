#!/usr/bin/env bash
# Build + deploy the Elevator vault contract and configure the token allow-list.
# Usage: scripts/deploy_contract.sh [testnet|mainnet]   (reads PLATFORM_SECRET from .env; writes deploy/contract.<net>.json and VAULT_CONTRACT_ID into .env)
set -euo pipefail
NET="${1:-testnet}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
export PATH="$HOME/.cargo/bin:$PATH"
set -a; source .env; set +a
[ -n "${PLATFORM_SECRET:-}" ] || { echo "PLATFORM_SECRET missing in .env" >&2; exit 1; }

if [ "$NET" = "testnet" ]; then
  ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
  TOKENS_BASE="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA CB3TLW74NBIOT3BUWOZ3TUM6RFDF6A4GVIRUQRQZABG5KPOUL4JJOV2F"   # XLM, Circle USDC, Soroswap USDC
  TOKENS_TRADE="CBQDUWBOHS7P4TZIJ3KUPUZQOWMKJC6CQPPFEONSV3BH4X27YVEXWNOT"   # EURC (soroswap)
else
  ROUTER=CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH
  TOKENS_BASE="CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"   # XLM, USDC
  TOKENS_TRADE=""
fi

# identity from the platform secret (never printed)
stellar keys add platform --secret-key <<<"$PLATFORM_SECRET" >/dev/null 2>&1 || true
ADMIN=$(stellar keys public-key platform)
echo "admin/platform: $ADMIN  network: $NET"

echo "[1/4] build"
( cd contracts && stellar contract build --package elevator_vault 2>&1 | tail -3 )
WASM=$(ls contracts/target/wasm32v1-none/release/elevator_vault.wasm)
echo "wasm: $WASM ($(stat -c %s "$WASM") bytes)"

echo "[2/4] deploy"
DEPLOY_LOG="deploy/deploy.$NET.log"; mkdir -p deploy
CID=$(stellar contract deploy --wasm "$WASM" --source-account platform --network "$NET" \
  -- --admin "$ADMIN" --router "$ROUTER" --fee_recipient "$ADMIN" --platform_fee_bps "${PLATFORM_FEE_BPS:-0}" --settle_slippage_bps 100 2>"$DEPLOY_LOG" | tail -1)
[ -n "$CID" ] || { echo "deploy failed, see $DEPLOY_LOG" >&2; exit 1; }
echo "contract id: $CID"

echo "[3/4] allow-list tokens"
for t in $TOKENS_BASE; do stellar contract invoke --id "$CID" --source-account platform --network "$NET" -- set_token --token "$t" --allowed true --is_base true >/dev/null && echo "  base  $t"; done
for t in $TOKENS_TRADE; do stellar contract invoke --id "$CID" --source-account platform --network "$NET" -- set_token --token "$t" --allowed true --is_base false >/dev/null && echo "  trade $t"; done

echo "[4/4] record"
mkdir -p deploy
python3 - "$NET" "$CID" "$ROUTER" "$ADMIN" "$WASM" <<'PY'
import json, sys, hashlib, datetime
net, cid, router, admin, wasm = sys.argv[1:]
h = hashlib.sha256(open(wasm, 'rb').read()).hexdigest()
json.dump({"network": net, "contract_id": cid, "router": router, "admin": admin, "wasm_sha256": h,
           "deployed_at": datetime.datetime.now(datetime.timezone.utc).isoformat()},  # timezone.utc: host python may be < 3.11
          open(f"deploy/contract.{net}.json", "w"), indent=2)
PY
if grep -q '^VAULT_CONTRACT_ID=' .env; then sed -i "s/^VAULT_CONTRACT_ID=.*/VAULT_CONTRACT_ID=$CID/" .env; else echo "VAULT_CONTRACT_ID=$CID" >> .env; fi
if grep -q '^SOROSWAP_ROUTER_ID=' .env; then sed -i "s/^SOROSWAP_ROUTER_ID=.*/SOROSWAP_ROUTER_ID=$ROUTER/" .env; else echo "SOROSWAP_ROUTER_ID=$ROUTER" >> .env; fi
echo "done: deploy/contract.$NET.json written; .env updated"
