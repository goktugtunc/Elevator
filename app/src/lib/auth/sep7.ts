import { authApi } from '@/lib/api';
import { buildSignInUri, openInWallet } from '@/lib/wallet';

import { jwtExpiresAt } from './jwt';
import { Sep10Error, assertValidChallenge } from './sep10';
import type { Sep10Session } from './sep10';
import { stellarConfig } from '@/lib/stellar';

/**
 * SEP-7 ile giriş — imza harici cüzdanda atılır, imzalı XDR **cüzdandan doğrudan
 * backend'e** gider; uygulama sonucu yoklayarak bekler. Üçüncü taraf relay yok.
 *
 *   1. challenge  → POST /auth/challenge      (id + transaction döner)
 *   2. imza       → web+stellar:tx?...&callback=url:<api>/auth/sep7-callback
 *   3. bekleme    → GET  /auth/sep7-status/:id  (pending → completed/failed)
 *
 * Uç nokta sözleşmesi ve sunucu tarafı doğrulama adımları: docs/backend-sozlesme.md
 */
export interface Sep7SignInHandle {
  requestId: string;
  uri: string;
}

/** Challenge alır, doğrular ve cüzdanı açar. Sonucu `waitForSep7` bekler. */
export async function startSep7SignIn(address: string): Promise<Sep7SignInHandle> {
  const { transaction, networkPassphrase, id } = await authApi.challenge(address);

  if (networkPassphrase !== stellarConfig.networkPassphrase) {
    throw new Sep10Error(
      `The server issued a challenge for a different network. This app is on ${stellarConfig.network}.`,
      'WRONG_NETWORK',
    );
  }
  assertValidChallenge(transaction, { address, networkPassphrase });

  if (!id) {
    throw new Sep10Error(
      'The server did not return a request id for the SEP-7 flow (see docs/backend-sozlesme.md).',
      'INVALID_CHALLENGE',
    );
  }

  const uri = buildSignInUri(transaction, address);
  await openInWallet(uri);
  return { requestId: id, uri };
}

export interface WaitOptions {
  /** Toplam bekleme süresi (ms). Varsayılan: 3 dakika. */
  timeoutMs?: number;
  /** Yoklama aralığı (ms). */
  intervalMs?: number;
  /** İptal için: true dönerse bekleme durur. */
  isCancelled?: () => boolean;
}

/** Cüzdan imzalayıp backend doğrulayana kadar durumu yoklar. */
export async function waitForSep7(
  requestId: string,
  { timeoutMs = 180_000, intervalMs = 2_000, isCancelled }: WaitOptions = {},
): Promise<Sep10Session> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isCancelled?.()) throw new Sep10Error('Sign-in was cancelled.', 'EXPIRED_CHALLENGE');

    const status = await authApi.sep7Status(requestId);

    if (status.status === 'completed' && status.token) {
      const expiresAtMs = status.expiresAt
        ? Date.parse(status.expiresAt)
        : jwtExpiresAt(status.token);
      return {
        token: status.token,
        expiresAt: Number.isFinite(expiresAtMs) ? (expiresAtMs as number) : null,
      };
    }
    if (status.status === 'failed') {
      throw new Sep10Error(
        status.message || 'The wallet signature was rejected.',
        'INVALID_CHALLENGE',
      );
    }

    await sleep(intervalMs);
  }

  throw new Sep10Error('Timed out waiting for the wallet signature.', 'EXPIRED_CHALLENGE');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
