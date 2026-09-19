/**
 * Native (iOS/Android) cüzdan adaptörü — iki imza yolu arasında geçiş yapar:
 *
 *   local         → anahtar cihazda üretilir ve saklanır (./local.ts). Varsayılan.
 *   walletconnect → harici cüzdan, reown relay'i üzerinden (./walletconnect.ts).
 *                   `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` yoksa kapalıdır.
 *
 * Üçüncü bir yol olan **SEP-7** (harici cüzdan + kendi backend'imiz) imzayı
 * cihaza geri döndürmediği için bu arayüze girmez; giriş akışında ayrı ele alınır
 * (`lib/auth/sep7.ts`). Bkz. docs/backend-sozlesme.md.
 *
 * Metro web hedefinde bu dosya yerine ./wallet.web.ts kullanılır.
 */
import { localWallet } from './local';
import { WalletError, type ConnectOptions, type WalletAdapter } from './types';
import { walletConnectWallet } from './walletconnect';
import { env } from '@/lib/env';
import { STORAGE_KEYS, plainStorage } from '@/lib/storage';

export type NativeWalletMode = 'local' | 'walletconnect';

let mode: NativeWalletMode = 'local';

export function walletConnectAvailable(): boolean {
  return Boolean(env.walletConnectProjectId);
}

export async function restoreWalletMode(): Promise<NativeWalletMode> {
  const stored = await plainStorage.get(STORAGE_KEYS.walletMode);
  mode = stored === 'walletconnect' && walletConnectAvailable() ? 'walletconnect' : 'local';
  return mode;
}

async function setMode(next: NativeWalletMode): Promise<void> {
  mode = next;
  await plainStorage.set(STORAGE_KEYS.walletMode, next);
}

export const wallet: WalletAdapter = {
  /** Yerel cüzdan her cihazda kurulabilir; bu yüzden native taraf her zaman hazırdır. */
  available: true,

  async connect(options?: ConnectOptions) {
    const requested = options?.mode ?? mode;

    if (requested === 'walletconnect') {
      if (!walletConnectAvailable()) {
        throw new WalletError(
          'WalletConnect is not configured. Add EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID, or use the in-app wallet.',
          'MISSING_CONFIG',
        );
      }
      const result = await walletConnectWallet.connect(options);
      await setMode('walletconnect');
      return result;
    }

    const address = (await localWallet.address()) ?? (await localWallet.create());
    await setMode('local');
    return { address, walletId: 'local' };
  },

  async disconnect() {
    if (mode === 'walletconnect') await walletConnectWallet.disconnect();
    // Yerel cüzdan çıkışta silinmez: kullanıcı aynı adresle geri dönebilsin.
    // Silme işlemi Profil ekranındaki "Forget wallet" aksiyonuna bağlıdır.
  },

  async getAddress() {
    if (mode === 'walletconnect') return walletConnectWallet.getAddress();
    return localWallet.address();
  },

  async signTransaction(xdr, opts) {
    if (mode === 'walletconnect') return walletConnectWallet.signTransaction(xdr, opts);
    return localWallet.signTransaction(xdr, opts?.networkPassphrase);
  },
};
