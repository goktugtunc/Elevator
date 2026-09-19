/**
 * Native tarafta @stellar/stellar-sdk için gerekli polyfill'ler (gelistirme-notlari §4.2).
 * Sıra önemli: getRandomValues → Buffer. app/_layout.tsx'in İLK importu olmalı.
 * Web'de tarayıcı bunları zaten sağlar; import zararsızdır.
 */
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}
