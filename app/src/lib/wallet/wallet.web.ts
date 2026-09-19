/**
 * Web cüzdan adaptörü — Stellar Wallets Kit v2 (statik singleton).
 * Metro, web hedefinde bu dosyayı `./wallet` yerine çözer.
 *
 * Not: Kit'in modalı web component'tir; yalnızca tarayıcıda çalışır.
 * WalletConnect modülü ekstra kurulum ister (projectId) — mobil sprintinde eklenecek.
 */
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { FREIGHTER_ID, FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { Networks as KitNetworks } from '@creit.tech/stellar-wallets-kit/types';

import { WalletError, type ConnectOptions, type WalletAdapter } from './types';
import { stellarConfig } from '@/lib/stellar/config';

let initialized = false;

function ensureInit() {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: defaultModules(),
    network: stellarConfig.network === 'mainnet' ? KitNetworks.PUBLIC : KitNetworks.TESTNET,
  });
  initialized = true;
}

function mapError(err: unknown): WalletError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/reject|denied|cancel/i.test(msg))
    return new WalletError('The request was rejected in your wallet.', 'USER_REJECTED');
  if (/network/i.test(msg))
    return new WalletError(
      `Your wallet is on a different network. Switch it to ${stellarConfig.network === 'mainnet' ? 'Mainnet' : 'Testnet'}.`,
      'WRONG_NETWORK',
    );
  return new WalletError(msg || 'Wallet error', 'UNKNOWN');
}

export const wallet: WalletAdapter = {
  available: true,

  /**
   * `walletId` verilirse (ör. Freighter) modal açılmadan doğrudan o cüzdan
   * kullanılır; verilmezse Kit'in cüzdan seçim modalı açılır.
   */
  async connect(options?: ConnectOptions) {
    ensureInit();
    try {
      if (options?.walletId) {
        StellarWalletsKit.setWallet(options.walletId);
        const { address } = await StellarWalletsKit.getAddress();
        return { address, walletId: options.walletId };
      }
      const { address } = await StellarWalletsKit.authModal();
      return { address, walletId: StellarWalletsKit.selectedModule?.productId };
    } catch (err) {
      throw mapError(err);
    }
  },

  /** Web'de bekleyen eşleşme kavramı yok; Kit kendi modalını yönetir. */
  async abortPairing() {
    /* no-op */
  },

  async disconnect() {
    ensureInit();
    await StellarWalletsKit.disconnect();
  },

  async getAddress() {
    ensureInit();
    try {
      const { address } = await StellarWalletsKit.getAddress();
      return address || null;
    } catch {
      return null;
    }
  },

  async signTransaction(xdr, opts) {
    ensureInit();
    try {
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: opts?.networkPassphrase ?? stellarConfig.networkPassphrase,
        address: opts?.address,
      });
      return signedTxXdr;
    } catch (err) {
      throw mapError(err);
    }
  },

  async signAuthEntry(authEntryXdr, opts) {
    ensureInit();
    try {
      const { signedAuthEntry } = await StellarWalletsKit.signAuthEntry(authEntryXdr, {
        networkPassphrase: opts?.networkPassphrase ?? stellarConfig.networkPassphrase,
        address: opts?.address,
      });
      return signedAuthEntry;
    } catch (err) {
      throw mapError(err);
    }
  },
};

/**
 * Native adaptörle aynı yüzey: web'de imza yolu Stellar Wallets Kit'tir,
 * uygulama içi cüzdan ya da WalletConnect seçimi yoktur.
 */
export type NativeWalletMode = 'local' | 'walletconnect';

export function walletConnectAvailable(): boolean {
  return false;
}

/** Stellar Wallets Kit'teki Freighter modülünün kimliği. */
export const FREIGHTER_WALLET_ID = FREIGHTER_ID;

/** Freighter uzantısı tarayıcıda kurulu mu? */
export async function isFreighterAvailable(): Promise<boolean> {
  try {
    return await new FreighterModule().isAvailable();
  } catch {
    return false;
  }
}

export async function restoreWalletMode(): Promise<NativeWalletMode> {
  return 'local';
}
