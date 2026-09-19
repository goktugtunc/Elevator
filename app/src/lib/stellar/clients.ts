import { Horizon, rpc } from '@stellar/stellar-sdk';

import { stellarConfig } from './config';

let _rpc: rpc.Server | null = null;
let _horizon: Horizon.Server | null = null;

/** Soroban RPC istemcisi (tercih edilen). Kontrat okuma/simülasyon ve tx polling. */
export function getRpc(): rpc.Server {
  if (!_rpc) _rpc = new rpc.Server(stellarConfig.rpcUrl);
  return _rpc;
}

/** Horizon istemcisi (klasik işlemler, bakiye, ödeme geçmişi). */
export function getHorizon(): Horizon.Server {
  if (!_horizon) _horizon = new Horizon.Server(stellarConfig.horizonUrl);
  return _horizon;
}

/** Testnet'te hesabı Friendbot ile fonlar. Mainnet'te no-op. */
export async function fundWithFriendbot(address: string): Promise<boolean> {
  if (!stellarConfig.friendbotUrl) return false;
  const res = await fetch(`${stellarConfig.friendbotUrl}?addr=${encodeURIComponent(address)}`);
  return res.ok;
}

/** Hesabın XLM ve varlık bakiyeleri. Hesap fonlanmamışsa boş dizi döner. */
export async function getBalances(address: string) {
  try {
    const account = await getHorizon().loadAccount(address);
    return account.balances;
  } catch (err) {
    if (err instanceof Error && /404|not found/i.test(err.message)) return [];
    throw err;
  }
}
