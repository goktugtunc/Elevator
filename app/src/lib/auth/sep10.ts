import { TransactionBuilder } from '@stellar/stellar-sdk';

import { authApi } from '@/lib/api';
import { stellarConfig } from '@/lib/stellar';
import { wallet } from '@/lib/wallet';

import { jwtExpiresAt } from './jwt';

/**
 * SEP-10 giriş akışı (gelistirme-notlari §4.3):
 *   1. Backend'den challenge tx al  (POST /auth/challenge)
 *   2. Challenge'ı doğrula          (aşağıdaki assertValidChallenge)
 *   3. Cüzdanla imzala              (wallet.signTransaction)
 *   4. Backend'e gönder, JWT al     (POST /auth/verify)
 *
 * Sunucu da challenge'ı kendi tarafında doğrular; buradaki kontrol kullanıcıyı
 * "körlemesine imza"dan korur — imzalanan şey gerçekten bir giriş challenge'ı mı?
 * Cüzdanın yanlış ağda olması WalletError('WRONG_NETWORK') olarak yüzeye çıkar.
 */
export type Sep10ErrorCode =
  'WRONG_NETWORK' | 'INVALID_CHALLENGE' | 'EXPIRED_CHALLENGE' | 'ADDRESS_MISMATCH' | 'NO_TOKEN';

export class Sep10Error extends Error {
  constructor(
    message: string,
    public readonly code: Sep10ErrorCode,
  ) {
    super(message);
    this.name = 'Sep10Error';
  }
}

export interface Sep10Session {
  token: string;
  /** Token'ın bitiş anı (ms epoch). Sunucu `expiresAt` vermezse JWT `exp`'inden okunur. */
  expiresAt: number | null;
}

export async function loginWithSep10(address: string): Promise<Sep10Session> {
  const { transaction, networkPassphrase } = await authApi.challenge(address);

  if (networkPassphrase !== stellarConfig.networkPassphrase) {
    throw new Sep10Error(
      `Sunucu farklı bir ağ için challenge üretti. İstemci ${stellarConfig.network} ağında.`,
      'WRONG_NETWORK',
    );
  }

  assertValidChallenge(transaction, { address, networkPassphrase });

  const signed = await wallet.signTransaction(transaction, { networkPassphrase, address });
  const { token, expiresAt } = await authApi.verify(signed);

  if (!token) throw new Sep10Error('Sunucu oturum anahtarı döndürmedi.', 'NO_TOKEN');

  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : jwtExpiresAt(token);
  return { token, expiresAt: Number.isFinite(expiresAtMs) ? (expiresAtMs as number) : null };
}

/**
 * SEP-10 challenge'ının biçim kontrolü (SEP-0010 §Verification):
 * sequence 0, zaman aralığı geçerli, ilk işlem istemci hesabına ait bir `manageData`.
 */
export function assertValidChallenge(
  xdr: string,
  { address, networkPassphrase }: { address: string; networkPassphrase: string },
): void {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new Sep10Error('Sunucudan gelen challenge çözümlenemedi.', 'INVALID_CHALLENGE');
  }

  if ('innerTransaction' in tx) {
    throw new Sep10Error('Challenge fee-bump işlemi olamaz.', 'INVALID_CHALLENGE');
  }

  if (tx.sequence !== '0') {
    throw new Sep10Error('Challenge sequence numarası 0 olmalı.', 'INVALID_CHALLENGE');
  }

  const bounds = tx.timeBounds;
  if (!bounds) {
    throw new Sep10Error('Challenge zaman aralığı taşımıyor.', 'INVALID_CHALLENGE');
  }
  const now = Math.floor(Date.now() / 1000);
  const minTime = Number(bounds.minTime);
  const maxTime = Number(bounds.maxTime);
  if (maxTime === 0 || now > maxTime) {
    throw new Sep10Error('Challenge süresi doldu. Girişi tekrar başlat.', 'EXPIRED_CHALLENGE');
  }
  if (now + 60 < minTime) {
    throw new Sep10Error('Challenge henüz geçerli değil (saat farkı?).', 'EXPIRED_CHALLENGE');
  }

  const first = tx.operations[0];
  if (!first || first.type !== 'manageData') {
    throw new Sep10Error('Challenge beklenen manageData işlemini içermiyor.', 'INVALID_CHALLENGE');
  }
  if (first.source !== address) {
    throw new Sep10Error(
      'Challenge başka bir cüzdan adresi için üretilmiş. Bağlı cüzdanı kontrol et.',
      'ADDRESS_MISMATCH',
    );
  }
}
