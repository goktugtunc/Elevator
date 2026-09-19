/**
 * WalletConnect v2 (`UniversalProvider`) ile harici cüzdan — **isteğe bağlı**.
 *
 * Neden WalletConnect: mobilde tarayıcı uzantısı yok; Stellar cüzdanları
 * (Lobstr, xBull…) WalletConnect v2 üzerinden `stellar_signXDR` destekler.
 * Expo Go uyumlu: paket saf JS, native modül gerektirmez (polyfill'ler
 * `src/polyfills.ts` içinde expo-crypto ile sağlanır).
 *
 * Akış: connect() → `display_uri` olayı → UI QR/deep link gösterir →
 * kullanıcı cüzdanda onaylar → oturum kurulur, adres CAIP hesabından okunur.
 * Oturum WalletConnect'in kendi deposunda (AsyncStorage) kalıcıdır.
 *
 * Bu yol reown (cloud.reown.com) relay'ine bağlıdır; proje kimliği yoksa kapalı
 * kalır ve uygulama yerel cüzdan ile SEP-7'yi kullanır (bkz. ./wallet.ts).
 */
import * as Linking from 'expo-linking';

import { UniversalProvider } from '@walletconnect/universal-provider';

import { WalletError, type ConnectOptions, type WalletAdapter } from './types';
import { debugError, debugLog } from '@/lib/log';
import { env } from '@/lib/env';
import { stellarConfig } from '@/lib/stellar/config';

/** Paket hem default hem adlandırılmış dışa aktarım yapıyor; tip için örnek türünü alıyoruz. */
type Provider = InstanceType<typeof UniversalProvider>;

/** CAIP-2 zincir kimliği — Stellar: `stellar:pubnet` / `stellar:testnet`. */
const CHAIN = `stellar:${stellarConfig.network === 'mainnet' ? 'pubnet' : 'testnet'}`;

/** WalletConnect Stellar yöntemleri (SEP tarafı değil, cüzdan RPC'si). */
const METHODS = ['stellar_signXDR', 'stellar_signAndSubmitXDR'];

/**
 * Cüzdan imzadan sonra buraya geri döner. Expo Go'da uygulamanın kendi scheme'i
 * (traderkirala://) kayıtlı DEĞİLDİR; `Linking.createURL` Expo Go'da
 * `exp://<host>/--/` üretir, derlenmiş uygulamada `traderkirala://`.
 */
const RETURN_URL = Linking.createURL('/');

const APP_METADATA = {
  name: 'TraderKirala',
  description: 'Rent a trader, keep your capital on Stellar.',
  url: 'https://traderkirala.app',
  icons: ['https://traderkirala.app/icon.png'],
  redirect: { native: RETURN_URL, universal: '' },
};

let providerPromise: Promise<Provider> | null = null;

function requireProjectId(): string {
  if (!env.walletConnectProjectId) {
    throw new WalletError(
      'WalletConnect project ID is missing. Add EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID to .env (free at cloud.reown.com).',
      'MISSING_CONFIG',
    );
  }
  return env.walletConnectProjectId;
}

async function getProvider(): Promise<Provider> {
  if (!providerPromise) {
    providerPromise = UniversalProvider.init({
      projectId: requireProjectId(),
      metadata: APP_METADATA,
    });
  }
  return providerPromise;
}

/** "stellar:testnet:GABC…" → "GABC…" */
function addressFromAccount(account: string): string {
  const parts = account.split(':');
  return parts[parts.length - 1];
}

function sessionAddress(provider: Provider): string | null {
  const accounts = provider.session?.namespaces?.stellar?.accounts;
  if (!accounts || accounts.length === 0) return null;
  return addressFromAccount(accounts[0]);
}

function mapError(err: unknown): WalletError {
  if (err instanceof WalletError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/reject|denied|cancel|closed/i.test(msg))
    return new WalletError('The request was rejected in your wallet.', 'USER_REJECTED');
  if (/chain|namespace|network/i.test(msg))
    return new WalletError(
      `Your wallet is on a different network. Switch it to ${stellarConfig.network === 'mainnet' ? 'Mainnet' : 'Testnet'}.`,
      'WRONG_NETWORK',
    );
  if (/expire|timeout/i.test(msg))
    return new WalletError('The connection request timed out. Try again.', 'UNKNOWN');
  return new WalletError(msg || 'Wallet error', 'UNKNOWN');
}

export const walletConnectWallet: WalletAdapter = {
  /** Proje kimliği yoksa bağlanma denenmez; UI kurulum mesajı gösterir. */
  get available() {
    return Boolean(env.walletConnectProjectId);
  },

  async connect(options?: ConnectOptions) {
    try {
      const provider = await getProvider();
      // Önceki deneme yarıda kaldıysa (kullanıcı QR ekranını kapattı) temizle;
      // aksi hâlde connect() promise'i askıda kalıp dinleyici biriktiriyor.
      try {
        provider.abortPairingAttempt();
      } catch {
        /* bekleyen deneme yoksa sorun değil */
      }

      // Zaten kurulu bir oturum varsa cüzdanı tekrar yormayalım.
      const existing = sessionAddress(provider);
      if (existing) return { address: existing, walletId: 'walletconnect' };

      debugLog('wallet:wc', 'eşleşme başlatılıyor', { chain: CHAIN, methods: METHODS });
      const onUri = (uri: string) => {
        debugLog('wallet:wc', 'display_uri alındı', { uri: uri.slice(0, 40) });
        options?.onUri?.(uri);
      };
      provider.on('display_uri', onUri);
      try {
        const session = await provider.connect({
          namespaces: {
            stellar: { methods: METHODS, chains: [CHAIN], events: [] },
          },
        });
        const account = session?.namespaces?.stellar?.accounts?.[0];
        debugLog('wallet:wc', 'oturum yanıtı', {
          accounts: session?.namespaces?.stellar?.accounts ?? null,
          peer: session?.peer?.metadata?.name ?? null,
        });
        if (!account) {
          throw new WalletError('The wallet did not return a Stellar account.', 'NOT_CONNECTED');
        }
        return { address: addressFromAccount(account), walletId: 'walletconnect' };
      } finally {
        provider.off('display_uri', onUri);
      }
    } catch (err) {
      debugError('wallet:wc', 'bağlantı başarısız', err);
      throw mapError(err);
    }
  },

  /** QR ekranı kapatıldığında bekleyen eşleşmeyi bırakır. */
  async abortPairing() {
    const provider = await getProvider().catch(() => null);
    if (!provider) return;
    try {
      provider.abortPairingAttempt();
    } catch {
      /* bekleyen deneme yoktu */
    }
    await provider.cleanupPendingPairings().catch(() => undefined);
  },

  async disconnect() {
    const provider = await getProvider().catch(() => null);
    if (!provider?.session) return;
    await provider.disconnect().catch(() => undefined);
  },

  async getAddress() {
    try {
      const provider = await getProvider();
      return sessionAddress(provider);
    } catch {
      return null;
    }
  },

  async signTransaction(xdr) {
    try {
      const provider = await getProvider();
      if (!provider.session) {
        throw new WalletError('Wallet is not connected.', 'NOT_CONNECTED');
      }
      const result = await provider.request<{ signedXDR: string }>(
        { method: 'stellar_signXDR', params: { xdr } },
        CHAIN,
      );
      if (!result?.signedXDR) {
        throw new WalletError('The wallet returned an empty signature.', 'UNKNOWN');
      }
      return result.signedXDR;
    } catch (err) {
      throw mapError(err);
    }
  },
};
