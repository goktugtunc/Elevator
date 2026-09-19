/**
 * SEP-0007 — Stellar URI Scheme ile harici cüzdan imzası.
 *
 * Akış (üçüncü taraf servis yok, her şey kendi backend'imizden geçer):
 *   1. Kullanıcı cüzdan adresini verir (yapıştırma ya da QR).
 *   2. Backend `POST /auth/challenge` ile SEP-10 challenge XDR'ı üretir.
 *   3. Uygulama `web+stellar:tx?xdr=…&callback=url:<api>/auth/sep7-callback` linkini açar.
 *   4. Telefondaki cüzdan (Lobstr, xBull…) imzalar ve imzalı XDR'ı **callback'e POST eder**
 *      (SEP-7: `application/x-www-form-urlencoded`, alan adı `xdr`).
 *   5. Backend imzayı doğrular, JWT üretir; uygulama `GET /auth/sep7-status/:id` ile bekler.
 *
 * Uç nokta sözleşmesi: docs/backend-sozlesme.md
 */
import * as Linking from 'expo-linking';

import { WalletError } from './types';
import { env } from '@/lib/env';
import { stellarConfig } from '@/lib/stellar/config';

export const SEP7_SCHEME = 'web+stellar';

export interface Sep7TxParams {
  /** İmzalanacak XDR (SEP-10 challenge). */
  xdr: string;
  /** İmzalı XDR'ın POST edileceği mutlak URL. */
  callbackUrl: string;
  /** Cüzdanda gösterilecek kısa açıklama (SEP-7 `msg`, en fazla 300 karakter). */
  message?: string;
  /** İmzayı atması beklenen hesap (SEP-7 `pubkey`) — cüzdan doğru hesabı seçer. */
  pubkey?: string;
  /** İmza isteğini doğrulayan alan adı (SEP-7 `origin_domain`). */
  originDomain?: string;
}

/** `web+stellar:tx?...` URI'sini üretir. */
export function buildSep7TxUri({
  xdr,
  callbackUrl,
  message,
  pubkey,
  originDomain,
}: Sep7TxParams): string {
  const params = new URLSearchParams();
  params.set('xdr', xdr);
  // SEP-7: callback değeri "url:" öneki ile verilir.
  params.set('callback', `url:${callbackUrl}`);
  params.set('network_passphrase', stellarConfig.networkPassphrase);
  if (message) params.set('msg', message.slice(0, 300));
  if (pubkey) params.set('pubkey', pubkey);
  if (originDomain) params.set('origin_domain', originDomain);
  return `${SEP7_SCHEME}:tx?${params.toString()}`;
}

/** Giriş (SEP-10) challenge'ı için hazır URI. */
export function buildSignInUri(challengeXdr: string, address: string): string {
  const base = env.apiBaseUrl.replace(/\/+$/, '');
  return buildSep7TxUri({
    xdr: challengeXdr,
    callbackUrl: `${base}/api/v1/auth/sep7-callback`,
    message: 'Sign in to TraderKirala',
    pubkey: address,
    originDomain: hostOf(env.apiBaseUrl),
  });
}

/**
 * URI'yi cihazdaki cüzdan uygulamasına açar.
 * Hiçbir uygulama `web+stellar` şemasını karşılamıyorsa anlaşılır hata verir.
 */
export async function openInWallet(uri: string): Promise<void> {
  try {
    await Linking.openURL(uri);
  } catch {
    throw new WalletError(
      'No Stellar wallet responded. Install Lobstr or xBull, then try again.',
      'NOT_AVAILABLE',
    );
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
