import { TransactionBuilder } from '@stellar/stellar-sdk';

import { ApiError, authApi } from '@/lib/api';
import { debugError, debugLog } from '@/lib/log';
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
  | 'BACKEND_MISSING'
  | 'WRONG_NETWORK'
  | 'INVALID_CHALLENGE'
  | 'EXPIRED_CHALLENGE'
  | 'ADDRESS_MISMATCH'
  | 'NO_TOKEN';

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
  debugLog('auth:sep10', 'challenge isteniyor', { address });
  let challenge;
  try {
    challenge = await authApi.challenge(address);
  } catch (err) {
    debugError('auth:sep10', 'challenge alınamadı (backend hazır mı?)', err);
    if (err instanceof ApiError && err.status === 404) {
      throw new Sep10Error(
        'Sign-in is not available yet: the server has no /auth/challenge endpoint (SEP-10). Connecting a wallet works; this step needs the backend.',
        'BACKEND_MISSING',
      );
    }
    throw err;
  }
  const { transaction, networkPassphrase } = challenge;
  debugLog('auth:sep10', 'challenge alındı, doğrulanıyor');

  if (networkPassphrase !== stellarConfig.networkPassphrase) {
    throw new Sep10Error(
      `The server issued a challenge for a different network. This app is on ${stellarConfig.network}.`,
      'WRONG_NETWORK',
    );
  }

  assertValidChallenge(transaction, { address, networkPassphrase });

  debugLog('auth:sep10', 'cüzdandan imza isteniyor');
  const signed = await wallet.signTransaction(transaction, { networkPassphrase, address });
  debugLog('auth:sep10', 'imza alındı, /auth/verify çağrılıyor');
  let verified;
  try {
    verified = await authApi.verify(signed);
  } catch (err) {
    debugError('auth:sep10', '/auth/verify başarısız', err);
    throw err;
  }
  const { token, expiresAt } = verified;
  debugLog('auth:sep10', 'giriş tamam', { expiresAt: expiresAt ?? 'JWT exp' });

  if (!token) throw new Sep10Error('The server did not return a session token.', 'NO_TOKEN');

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
    throw new Sep10Error('The challenge from the server could not be parsed.', 'INVALID_CHALLENGE');
  }

  if ('innerTransaction' in tx) {
    throw new Sep10Error('A challenge cannot be a fee-bump transaction.', 'INVALID_CHALLENGE');
  }

  if (tx.sequence !== '0') {
    throw new Sep10Error('The challenge sequence number must be 0.', 'INVALID_CHALLENGE');
  }

  const bounds = tx.timeBounds;
  if (!bounds) {
    throw new Sep10Error('The challenge has no time bounds.', 'INVALID_CHALLENGE');
  }
  const now = Math.floor(Date.now() / 1000);
  const minTime = Number(bounds.minTime);
  const maxTime = Number(bounds.maxTime);
  if (maxTime === 0 || now > maxTime) {
    throw new Sep10Error('The challenge expired. Start signing in again.', 'EXPIRED_CHALLENGE');
  }
  if (now + 60 < minTime) {
    throw new Sep10Error('The challenge is not valid yet (clock skew?).', 'EXPIRED_CHALLENGE');
  }

  const first = tx.operations[0];
  if (!first || first.type !== 'manageData') {
    throw new Sep10Error(
      'The challenge does not contain the expected manageData operation.',
      'INVALID_CHALLENGE',
    );
  }
  if (first.source !== address) {
    throw new Sep10Error(
      'The challenge was issued for a different wallet address. Check the connected wallet.',
      'ADDRESS_MISMATCH',
    );
  }
}
