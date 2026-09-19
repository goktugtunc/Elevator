/**
 * Native (iOS/Android) cüzdan adaptörü — HENÜZ STUB.
 * Sprint görevi: Freighter mobile + WalletConnect v2 (UniversalProvider) prototipi.
 * Bkz. SPRINT-1.md → "Mobil cüzdan prototipi". Prototip başarısız olursa
 * mobil teslim yalnızca cüzdansız ekranlarla sınırlı kalır; web birincil hedeftir.
 *
 * Metro web hedefinde bu dosya yerine ./wallet.web.ts kullanılır.
 */
import { WalletError, type WalletAdapter } from './types';

const notReady = () =>
  new WalletError(
    'Mobil cüzdan bağlantısı henüz hazır değil. Web sürümünü kullanın veya WalletConnect prototipini bekleyin.',
    'NOT_AVAILABLE',
  );

export const wallet: WalletAdapter = {
  available: false,
  async connect() {
    throw notReady();
  },
  async disconnect() {
    /* no-op */
  },
  async getAddress() {
    return null;
  },
  async signTransaction() {
    throw notReady();
  },
};
