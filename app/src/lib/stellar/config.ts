import { Networks } from '@stellar/stellar-sdk';

import { env } from '@/lib/env';

/**
 * Stellar ağ yapılandırması. Hackathon boyunca yalnızca TESTNET.
 * Horizon / RPC istemcileri tembel oluşturulur (bkz. ./clients.ts) — bundle'a
 * gereksiz yük binmesin ve web/native polyfill sırası bozulmasın.
 */
export const stellarConfig = {
  network: env.stellarNetwork,
  networkPassphrase: env.stellarNetwork === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
  rpcUrl: env.rpcUrl,
  horizonUrl: env.horizonUrl,
  friendbotUrl: env.stellarNetwork === 'testnet' ? 'https://friendbot.stellar.org' : null,
  explorerBase:
    env.stellarNetwork === 'mainnet'
      ? 'https://stellar.expert/explorer/public'
      : 'https://stellar.expert/explorer/testnet',
} as const;

/** "GABC…WXYZ" biçiminde kısaltılmış adres (Figma'daki 0x71C7…9a3F karşılığı). */
export function shortAddress(address: string, head = 4, tail = 4): string {
  if (!address || address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function explorerTxUrl(hash: string): string {
  return `${stellarConfig.explorerBase}/tx/${hash}`;
}

export function explorerAccountUrl(address: string): string {
  return `${stellarConfig.explorerBase}/account/${address}`;
}
