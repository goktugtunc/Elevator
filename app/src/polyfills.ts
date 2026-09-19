/**
 * Native tarafta @stellar/stellar-sdk ve WalletConnect için gerekli polyfill'ler.
 * **Uygulamanın ilk çalışan modülü olmalı** — giriş noktası `app/index.js`.
 *
 * Neden bu kadar erken: `@noble/hashes/crypto.js` (stellar-sdk ve WalletConnect'in
 * bağımlılığı) `globalThis.crypto`'yu import anında yakalar; o an tanımlı değilse
 * bir daha bakmaz ve "crypto.getRandomValues must be defined" hatası verir.
 *
 * Expo Go kısıtı: özel native modül kullanılamaz. Bu yüzden rastgelelik
 * `react-native-get-random-values` yerine Expo SDK'nın `expo-crypto` modülünden
 * gelir; web'de tarayıcı zaten sağladığı için polyfill devreye girmez.
 */
import 'fast-text-encoding';

import { Buffer } from 'buffer';
import { getRandomValues as expoGetRandomValues, randomUUID as expoRandomUUID } from 'expo-crypto';

type MutableCrypto = {
  getRandomValues?: unknown;
  randomUUID?: unknown;
};

type Globals = typeof globalThis & {
  Buffer?: typeof Buffer;
  crypto?: MutableCrypto;
};

const g = globalThis as Globals;

function define(target: object, key: string, value: unknown): void {
  try {
    (target as Record<string, unknown>)[key] = value;
    if ((target as Record<string, unknown>)[key] === value) return;
  } catch {
    // salt-okunur özellik: aşağıdaki defineProperty ile deneriz
  }
  try {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  } catch {
    // burada da başarısızsa yapacak bir şey yok; çağıran taraf hata verecek
  }
}

const getRandomValues = <T extends ArrayBufferView | null>(array: T): T =>
  (array ? expoGetRandomValues(array as unknown as Uint8Array) : array) as T;

if (!g.crypto || typeof g.crypto !== 'object') {
  define(g, 'crypto', {});
}

const cryptoObj = g.crypto as MutableCrypto;

if (typeof cryptoObj.getRandomValues !== 'function') {
  define(cryptoObj, 'getRandomValues', getRandomValues);
}

// Bazı kütüphaneler (WalletConnect dâhil) randomUUID'yi doğrudan arıyor.
if (typeof cryptoObj.randomUUID !== 'function') {
  define(cryptoObj, 'randomUUID', () => expoRandomUUID());
}

// crypto nesnesi salt-okunur çıktıysa (bazı Hermes sürümleri) tümünü değiştir.
if (typeof (g.crypto as MutableCrypto).getRandomValues !== 'function') {
  define(g, 'crypto', { ...(g.crypto as object), getRandomValues, randomUUID: expoRandomUUID });
}

if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
