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
 * Bu yol reown relay'ine bağlıdır; proje kimliği yoksa kapalı kalır
 * (bkz. ./wallet.ts).
 */
import * as ExpoLinking from 'expo-linking';
import { UniversalProvider } from '@walletconnect/universal-provider';
import { Linking } from 'react-native';

import { WC_WALLETS } from './deeplinks';
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
 * (elevator://) kayıtlı DEĞİLDİR; `Linking.createURL` Expo Go'da
 * `exp://<host>/--/` üretir, derlenmiş uygulamada `elevator://`.
 */
const RETURN_URL = ExpoLinking.createURL('/');

const APP_METADATA = {
  name: 'Elevator',
  description: 'Rent a trader, keep your capital on Stellar.',
  url: 'https://elevator.app',
  icons: ['https://elevator.app/icon.png'],
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

/**
 * Oturumu hem relay'den hem yerel depodan düşürür.
 *
 * `disconnect()` tek başına yetmiyor: relay oturumu zaten unuttuysa çağrının
 * kendisi "No matching key" ile patlıyor ve AsyncStorage'daki kayıt yerinde
 * kalıyor. Kayıt kalınca `connect()` her seferinde ölü oturumu geri veriyor,
 * kullanıcı da "Connect wallet" dedikçe aynı hatayı alıyor. Bu yüzden relay
 * çağrısı başarısız olsa bile yerel kayıt siliniyor.
 */
async function forgetSession(provider: Provider): Promise<void> {
  const topic = provider.session?.topic;
  debugLog('wallet:wc', 'ölü oturum düşürülüyor', { topic: topic ?? null });
  try {
    await provider.disconnect();
  } catch (err) {
    debugError('wallet:wc', 'disconnect başarısız (relay zaten bilmiyor olabilir)', err);
  }
  const client = (provider as unknown as { client?: { session?: { delete(topic: string, reason: { code: number; message: string }): Promise<void> } } }).client;
  if (topic && client?.session) {
    await client.session
      .delete(topic, { code: 6000, message: 'stale session' })
      .catch(() => undefined);
  }
  (provider as unknown as { session?: unknown }).session = undefined;
}

/**
 * Kayıtlı oturum gerçekten ayakta mı?
 *
 * Süresi dolmuşsa relay'e sormaya gerek yok. Değilse `ping` atılır: cevap
 * gelmezse oturum relay tarafında yok demektir. İmza isteğinin ortasında
 * öğrenmektense burada öğrenmek daha iyi — orada kullanıcı cüzdanı açmış,
 * beklemiş ve eli boş dönmüş oluyor.
 */
async function sessionIsAlive(provider: Provider): Promise<boolean> {
  const topic = provider.session?.topic;
  if (!topic) return false;

  const expiry = provider.session?.expiry;
  if (typeof expiry === 'number' && expiry * 1000 <= Date.now()) {
    debugLog('wallet:wc', 'kayıtlı oturumun süresi dolmuş', { expiry });
    return false;
  }

  const client = (provider as unknown as { client?: { ping(args: { topic: string }): Promise<void> } }).client;
  if (!client?.ping) return true; // soramıyorsak oturuma güven; hata imza adımında yakalanır

  try {
    await withTimeout(client.ping({ topic }), PING_TIMEOUT_MS);
    return true;
  } catch (err) {
    debugError('wallet:wc', 'oturum ping yanıtı yok — bayat sayılıyor', err);
    return false;
  }
}

/**
 * İmza isteği relay üzerinden cüzdana gider ama cüzdan uygulaması kendiliğinden
 * öne gelmez; dApp'in deep link ile açması gerekir. Adres:
 *   1. oturumdaki cüzdanın kendi `redirect.native`'i (en doğrusu)
 *   2. eşleşen cüzdanın kayıt defterindeki şeması
 * Açılamazsa sessiz geçilir — kullanıcı cüzdanı elle açıp onaylayabilir.
 */
async function bringWalletToFront(provider: Provider): Promise<void> {
  const peer = provider.session?.peer?.metadata;
  const fromSession = peer?.redirect?.native || peer?.redirect?.universal;
  const known = WC_WALLETS.find(
    (w) => peer?.name && w.label.toLowerCase() === peer.name.toLowerCase(),
  );
  const candidates = [fromSession, known?.native, known?.universal].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );

  debugLog('wallet:wc', 'cüzdan öne getiriliyor', { peer: peer?.name ?? null, candidates });

  for (const link of candidates) {
    try {
      await Linking.openURL(link);
      return;
    } catch {
      // sıradaki adresi dene
    }
  }
  debugLog('wallet:wc', 'cüzdan açılamadı — kullanıcı elle açmalı');
}

/** İstek yanıtsız kalırsa sonsuza kadar beklemeyelim. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Oturumun hâlâ yaşadığını relay'e sorarken beklenecek süre. */
const PING_TIMEOUT_MS = 8_000;

/**
 * Relay, kendisinde karşılığı kalmamış bir oturum/eşleşme için bunu döndürür.
 * AsyncStorage'daki oturum hayatta görünür ama ilk istekte bu hata gelir.
 */
function isStaleSessionError(msg: string): boolean {
  return /no matching key|topic doesn't exist|topic does not exist|session: |expired/i.test(msg);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new WalletError(
            'The wallet did not respond. Open your wallet app and approve the request, then try again.',
            'UNKNOWN',
          ),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Hata nesnesinden okunabilir metin.
 *
 * Relay düz nesne fırlatıyor ve bunun `message` alanı her zaman olmuyor —
 * kendi logger'ı `msg` kullanıyor. Eskiden `String(err)` çağrılıyordu, o da
 * kullanıcıya birebir "[object Object]" gösteriyordu.
 */
function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    for (const key of ['message', 'msg', 'reason', 'error']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* döngüsel nesne */
    }
    return '';
  }
  return err == null ? '' : String(err);
}

function mapError(err: unknown): WalletError {
  if (err instanceof WalletError) return err;
  const msg = errorText(err);
  if (isStaleSessionError(msg))
    return new WalletError(
      'Your wallet connection expired. Tap Connect again to pair your wallet.',
      'NOT_CONNECTED',
    );
  // Freighter kilitliyken isteği onay ekranı göstermeden reddediyor ve
  // "User rejected. User not authenticated" diyor. Bunu "siz reddettiniz"
  // diye göstermek yanıltıcı olur — yapılması gereken kilidi açmaktır.
  if (/not authenticated|unlock|locked/i.test(msg))
    return new WalletError(
      'Your wallet is locked. Open Freighter, unlock it, then try connecting again.',
      'NOT_CONNECTED',
    );
  if (/reject|denied|cancel|closed/i.test(msg))
    return new WalletError('The request was rejected in your wallet.', 'USER_REJECTED');
  if (/chain|namespace|network/i.test(msg))
    return new WalletError(
      `Your wallet is on a different network. Switch it to ${stellarConfig.network === 'mainnet' ? 'Mainnet' : 'Testnet'}.`,
      'WRONG_NETWORK',
    );
  if (/expire|timeout/i.test(msg))
    return new WalletError('The connection request timed out. Try again.', 'UNKNOWN');
  return new WalletError(msg || 'The wallet could not be reached. Try connecting again.', 'UNKNOWN');
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

      // Oturumu olmayan eski eşleşmeleri sil. Silinmezse SignClient bir sonraki
      // connect() çağrısında **aynı eşleşmeyi geri kullanıyor**: cüzdana zaten
      // harcanmış (reddedilmiş ya da süresi dolmuş) bir `wc:` URI'si gidiyor,
      // Freighter açılıyor ama onay ekranı hiç çıkmıyor. Her denemede taze bir
      // URI üretilmeli.
      try {
        await provider.cleanupPendingPairings({ deletePairings: true });
      } catch (err) {
        debugError('wallet:wc', 'eski eşleşmeler temizlenemedi', err);
      }

      // Zaten kurulu bir oturum varsa cüzdanı tekrar yormayalım — ama önce
      // gerçekten ayakta olduğunu doğrula. Kayıt yerinde durup relay'de
      // karşılığı kalmamış oluyor; o hâlde adresi geri vermek kullanıcıyı
      // imza adımında duvara çarptırıyor ve her denemede aynı yere düşüyor.
      // Ölüyse burada düşürülür ve aşağıdaki taze eşleşmeye devam edilir.
      const existing = sessionAddress(provider);
      if (existing) {
        if (await sessionIsAlive(provider)) {
          debugLog('wallet:wc', 'MEVCUT oturum kullanıldı, yeni eşleşme yok', { address: existing });
          return { address: existing, walletId: 'walletconnect' };
        }
        debugLog('wallet:wc', 'kayıtlı oturum ölü — temizlenip yeniden eşleşilecek', {
          address: existing,
        });
        await forgetSession(provider);
      } else {
        debugLog('wallet:wc', 'kayıtlı oturum yok, yeni eşleşme gerekiyor');
      }

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
      debugLog('wallet:wc', 'imza isteği gönderiliyor', { method: 'stellar_signXDR' });
      const pending = provider.request<{ signedXDR: string }>(
        { method: 'stellar_signXDR', params: { xdr } },
        CHAIN,
      );
      // İstek yolda iken cüzdanı öne getir; kullanıcı onay ekranını görsün.
      void bringWalletToFront(provider);
      const result = await withTimeout(pending, REQUEST_TIMEOUT_MS);
      debugLog('wallet:wc', 'imza alındı');
      if (!result?.signedXDR) {
        throw new WalletError('The wallet returned an empty signature.', 'UNKNOWN');
      }
      return result.signedXDR;
    } catch (err) {
      const mapped = mapError(err);
      // Oturum relay tarafında yoksa kaydı burada da düşür: aksi hâlde kullanıcı
      // "Connect" deyip aynı ölü oturuma geri dönüyor.
      if (mapped.code === 'NOT_CONNECTED' && isStaleSessionError(errorText(err))) {
        const provider = await getProvider().catch(() => null);
        if (provider) await forgetSession(provider).catch(() => undefined);
      }
      throw mapped;
    }
  },
};
