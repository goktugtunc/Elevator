"""Generate a complete .env with fresh secrets (run once on a new deployment).

Usage: python scripts/gen_env.py [--network testnet|public] [--domain mobilback.yolalapp.com] > .env
Never overwrites an existing .env by itself: it prints to stdout.
"""
from __future__ import annotations

import argparse
import base64
import os
import secrets

from stellar_sdk import Keypair


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--network", default="testnet", choices=["testnet", "public"])
    p.add_argument("--domain", default="mobilback.yolalapp.com")
    a = p.parse_args()

    sep10 = Keypair.random()
    platform = Keypair.random()
    lines = [
        "APP_ENV=prod",
        "LOG_LEVEL=INFO",
        "DOCS_ENABLED=true",
        f"POSTGRES_PASSWORD={secrets.token_urlsafe(32)}",
        f"JWT_SECRET={secrets.token_urlsafe(48)}",
        f"ADMIN_KEY={secrets.token_urlsafe(32)}",
        f"STELLAR_NETWORK={a.network}",
        f"HOME_DOMAIN={a.domain}",
        f"WEB_AUTH_DOMAIN={a.domain}",
        f"SEP10_SERVER_SECRET={sep10.secret}",
        f"# SEP10 public key: {sep10.public_key}",
        f"PLATFORM_SECRET={platform.secret}",
        f"# PLATFORM public key: {platform.public_key}",
        f"POOL_KEY_ENCRYPTION_KEY={base64.urlsafe_b64encode(os.urandom(32)).decode()}",
        "POOL_FUNDING_XLM=20",
        "PLATFORM_FEE_PCT=0",
        "DEFAULT_SLIPPAGE_PCT=1.0",
        "EXPO_PUSH_ENABLED=false",
        "EXPO_ACCESS_TOKEN=",
    ]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
