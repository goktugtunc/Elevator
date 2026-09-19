import { authApi } from '@/lib/api';
import { stellarConfig } from '@/lib/stellar';
import { wallet } from '@/lib/wallet';

/**
 * SEP-10 giriş akışı (gelistirme-notlari §4.3):
 *   1. Backend'den challenge tx al  (POST /auth/challenge)
 *   2. Cüzdanla imzala              (wallet.signTransaction)
 *   3. Backend'e gönder, JWT al     (POST /auth/verify)
 *
 * Challenge doğrulaması sunucu tarafındadır; istemci yalnızca imzalar.
 * Passphrase uyuşmazlığı (cüzdan mainnet'te) WalletError('WRONG_NETWORK') olarak yüzeye çıkar.
 */
export async function loginWithSep10(
  address: string,
): Promise<{ token: string; expiresAt?: string }> {
  const { transaction, networkPassphrase } = await authApi.challenge(address);

  if (networkPassphrase !== stellarConfig.networkPassphrase) {
    throw new Error(
      `Sunucu farklı bir ağ için challenge üretti (${networkPassphrase}). İstemci: ${stellarConfig.network}.`,
    );
  }

  const signed = await wallet.signTransaction(transaction, { networkPassphrase, address });
  return authApi.verify(signed);
}
