/**
 * Native tarafta @stellar/stellar-sdk ve WalletConnect için gerekli polyfill'ler.
 * Sıra önemli: TextEncoder → getRandomValues → Buffer. app/_layout.tsx'in İLK importu olmalı.
 *
 * Expo Go kısıtı: yalnızca Expo SDK modülleri ve Expo Go'ya gömülü kütüphaneler
 * kullanılabilir. Bu yüzden rastgelelik `react-native-get-random-values` (özel native
 * modül) yerine `expo-crypto` ile sağlanır — web'de tarayıcı zaten sağlar.
 */
import 'fast-text-encoding';

import { Buffer } from 'buffer';
import { getRandomValues } from 'expo-crypto';

type Globals = typeof globalThis & {
  Buffer?: typeof Buffer;
  crypto?: Crypto;
};

const g = globalThis as Globals;

if (typeof g.crypto === 'undefined') {
  g.crypto = {} as Crypto;
}

if (typeof g.crypto.getRandomValues !== 'function') {
  // expo-crypto imzası TypedArray alır; Crypto arayüzüyle uyumlu hâle getiriyoruz.
  g.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T =>
    (array
      ? getRandomValues(array as unknown as Uint8Array)
      : array) as T) as Crypto['getRandomValues'];
}

if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
