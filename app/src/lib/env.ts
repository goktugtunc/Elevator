/**
 * Ortam değişkenleri — tek giriş noktası. Şablon: .env.example
 * Expo, EXPO_PUBLIC_* değişkenlerini derleme zamanında satır içine yazar;
 * bu yüzden process.env erişimleri statik (dinamik anahtar yok) olmalı.
 */
function optional(value: string | undefined, fallback = ''): string {
  return value && value.length > 0 ? value : fallback;
}

export const env = {
  stellarNetwork: optional(process.env.EXPO_PUBLIC_STELLAR_NETWORK, 'testnet') as
    'testnet' | 'mainnet',
  rpcUrl: optional(process.env.EXPO_PUBLIC_STELLAR_RPC_URL, 'https://soroban-testnet.stellar.org'),
  horizonUrl: optional(
    process.env.EXPO_PUBLIC_STELLAR_HORIZON_URL,
    'https://horizon-testnet.stellar.org',
  ),
  apiBaseUrl: optional(process.env.EXPO_PUBLIC_API_BASE_URL, 'http://localhost:3000'),
  contracts: {
    listing: optional(process.env.EXPO_PUBLIC_CONTRACT_LISTING_ID),
    escrow: optional(process.env.EXPO_PUBLIC_CONTRACT_ESCROW_ID),
  },
  anchorHomeDomain: optional(process.env.EXPO_PUBLIC_ANCHOR_HOME_DOMAIN),
  relayerAddress: optional(process.env.EXPO_PUBLIC_RELAYER_ADDRESS),
  walletConnectProjectId: optional(process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID),
} as const;

/** Eksik ama zorunlu bir değer çağrıldığında anlaşılır hata üretir. */
export function requireEnv<T extends string>(value: T, name: string): T {
  if (!value) throw new Error(`Missing environment variable: ${name} (see .env.example)`);
  return value;
}
