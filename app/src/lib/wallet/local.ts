/**
 * Uygulama içi cüzdan — anahtar çifti cihazda üretilir ve **cihazda kalır**.
 *
 * Gizli anahtar `expo-secure-store` ile saklanır (iOS Keychain / Android Keystore);
 * sunucuya, backend'e ya da herhangi bir üçüncü tarafa gönderilmez. İmza cihazda
 * atılır, yalnızca imzalı XDR dışarı çıkar.
 *
 * Kapsam: hackathon Testnet demosu. Mainnet'te kullanıcıya donanım/harici cüzdan
 * (SEP-7 ya da Freighter) önerilir — bunu `docs/mobil-test.md` not eder.
 */
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

import { WalletError } from './types';
import { debugLog } from '@/lib/log';
import { stellarConfig } from '@/lib/stellar/config';
import { STORAGE_KEYS, secureStorage } from '@/lib/storage';

let cached: Keypair | null = null;

async function load(): Promise<Keypair | null> {
  if (cached) return cached;
  const secret = await secureStorage.get(STORAGE_KEYS.walletSecret);
  if (!secret) return null;
  try {
    cached = Keypair.fromSecret(secret);
    return cached;
  } catch {
    // Bozuk/eski kayıt: temizle, kullanıcı yeniden oluştursun.
    await secureStorage.remove(STORAGE_KEYS.walletSecret);
    return null;
  }
}

export const localWallet = {
  /** Cihazda kayıtlı cüzdan var mı? */
  async exists(): Promise<boolean> {
    return (await load()) !== null;
  },

  async address(): Promise<string | null> {
    return (await load())?.publicKey() ?? null;
  },

  /** Yeni anahtar çifti üretir ve saklar. Mevcut cüzdanın üstüne yazmaz. */
  async create(): Promise<string> {
    const existing = await load();
    if (existing) return existing.publicKey();
    const keypair = Keypair.random();
    await secureStorage.set(STORAGE_KEYS.walletSecret, keypair.secret());
    cached = keypair;
    debugLog('wallet:local', 'yeni cüzdan üretildi', { address: keypair.publicKey() });
    return keypair.publicKey();
  },

  /** Var olan gizli anahtarı (S…) içe aktarır. */
  async importSecret(secret: string): Promise<string> {
    const trimmed = secret.trim();
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(trimmed);
    } catch {
      throw new WalletError('That is not a valid Stellar secret key (starts with S).', 'UNKNOWN');
    }
    await secureStorage.set(STORAGE_KEYS.walletSecret, trimmed);
    cached = keypair;
    return keypair.publicKey();
  },

  /**
   * Gizli anahtarı yedekleme ekranı için döner. Çağıran taraf bunu asla
   * loglamamalı ya da ağa göndermemeli.
   */
  async exportSecret(): Promise<string | null> {
    return (await load())?.secret() ?? null;
  },

  async forget(): Promise<void> {
    cached = null;
    await secureStorage.remove(STORAGE_KEYS.walletSecret);
  },

  /** XDR'ı cihazdaki anahtarla imzalar (SEP-10 challenge ve Soroban işlemleri). */
  async signTransaction(xdr: string, networkPassphrase?: string): Promise<string> {
    const keypair = await load();
    if (!keypair) throw new WalletError('No in-app wallet on this device.', 'NOT_CONNECTED');
    try {
      const tx = TransactionBuilder.fromXDR(
        xdr,
        networkPassphrase ?? stellarConfig.networkPassphrase,
      );
      tx.sign(keypair);
      return tx.toXDR();
    } catch (err) {
      throw new WalletError(
        err instanceof Error ? err.message : 'The transaction could not be signed.',
        'UNKNOWN',
      );
    }
  },
};
