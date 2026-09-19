import { TransactionBuilder } from '@stellar/stellar-sdk';

import { ApiError, authApi } from '@/lib/api';
import type { LoginOut } from '@/lib/api/types';
import { debugError, debugLog } from '@/lib/log';
import { stellarConfig } from '@/lib/stellar';
import { wallet } from '@/lib/wallet';

/**
 * SEP-10 giriş akışı — TraderKirala API:
 *   1. `GET  /api/v1/auth/sep10?account=G…` → challenge XDR
 *   2. Challenge doğrulanır (körlemesine imza yok)
 *   3. Cüzdan imzalar
 *   4. `POST /api/v1/auth/sep10` { transaction } → JWT + kayıt durumu
 *
 * Yanıt (`LoginOut`) token'ın yanında `registered` ve varsa `user` taşır;
 * kayıtsız cüzdan için ayrı bir profil isteği gerekmez.
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
  /** ms epoch; sunucu `expires_at` verir. */
  expiresAt: number | null;
  publicKey: string;
  registered: boolean;
  user: LoginOut['user'];
}

export async function loginWithSep10(address: string): Promise<Sep10Session> {
  debugLog('auth:sep10', 'challenge isteniyor', { address });

  let challenge;
  try {
    challenge = await authApi.sep10Challenge(address);
  } catch (err) {
    debugError('auth:sep10', 'challenge alınamadı', err);
    if (err instanceof ApiError && err.status === 404) {
      throw new Sep10Error(
        'Sign-in endpoint not found on the server (/auth/sep10).',
        'BACKEND_MISSING',
      );
    }
    throw err;
  }

  const { transaction, network_passphrase: networkPassphrase } = challenge;

  if (networkPassphrase !== stellarConfig.networkPassphrase) {
    throw new Sep10Error(
      `The server issued a challenge for a different network. This app is on ${stellarConfig.network}.`,
      'WRONG_NETWORK',
    );
  }

  assertValidChallenge(transaction, { address, networkPassphrase });
  debugLog('auth:sep10', 'challenge doğrulandı, cüzdandan imza isteniyor');

  const signed = await wallet.signTransaction(transaction, { networkPassphrase, address });
  debugLog('auth:sep10', 'imza alındı, doğrulamaya gönderiliyor');

  let login: LoginOut;
  try {
    login = await authApi.sep10Verify(signed);
  } catch (err) {
    debugError('auth:sep10', 'imza doğrulanamadı', err);
    throw err;
  }

  if (!login.token) throw new Sep10Error('The server did not return a session token.', 'NO_TOKEN');

  const expiresAtMs = login.expires_at ? Date.parse(login.expires_at) : NaN;
  debugLog('auth:sep10', 'giriş tamam', {
    registered: login.registered,
    role: login.user?.role ?? null,
  });

  return {
    token: login.token,
    expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    publicKey: login.public_key,
    registered: login.registered,
    user: login.user,
  };
}

/**
 * SEP-0010 challenge'ının biçim kontrolü: sequence 0, zaman aralığı geçerli,
 * ilk işlem istemci hesabına ait bir `manageData`.
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
