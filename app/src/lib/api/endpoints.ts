import { http } from './client';
import type {
  AppNotification,
  Listing,
  Market,
  Message,
  MessageThread,
  Offer,
  RentalContract,
  RiskLevel,
  Trade,
  UserProfile,
  WalletTransaction,
} from '@/types';

/**
 * Backend API sözleşmesi — gelistirme-notlari.md §3.6.
 * Sunucu: https://mobilback.yolalapp.com (MobilApp Trader Pools API).
 * Uç noktalar `/api/v1` öneki altında; `/health` önek dışındadır.
 * Şu an yalnızca meta uçları canlı (config, health) — diğerleri 404 döner ve
 * ekranlar hata/boş durumu gösterir (sahte veri YOK, bkz. SPRINT-1.md).
 */
const V1 = '/api/v1';

/** Sunucunun açılışta verdiği genel yapılandırma (GET /api/v1/config). */
export interface PublicConfig {
  network: 'testnet' | 'mainnet' | string;
  network_passphrase: string;
  horizon_url: string;
  soroban_rpc_url: string;
  home_domain: string;
  api_prefix: string;
}

export interface HealthStatus {
  status: string;
  db?: string;
  version?: string;
}

// --- Meta (kimlik doğrulaması istemez) ---
export const metaApi = {
  config: () => http.get<PublicConfig>(`${V1}/config`, undefined, false),
  health: () => http.get<HealthStatus>('/health', undefined, false),
};

// --- Auth (SEP-10) ---
export const authApi = {
  challenge: (address: string) =>
    http.post<{ transaction: string; networkPassphrase: string }>(
      `${V1}/auth/challenge`,
      { account: address },
      false,
    ),
  verify: (signedTransaction: string) =>
    http.post<{ token: string; expiresAt?: string }>(
      `${V1}/auth/verify`,
      { transaction: signedTransaction },
      false,
    ),
};

// --- Profil & kayıt ---

/** `POST /register` gövdesi — Figma 1f Kayıt · Bilgiler (Müşteri), node 19:269. */
export interface CustomerRegisterPayload {
  role: 'customer';
  username: string;
  budgetTRY: number;
  riskPreference: RiskLevel;
  markets: Market[];
}

/** `POST /register` gövdesi — Figma 1g Kayıt · Bilgiler (Trader), node 19:353. */
export interface TraderRegisterPayload {
  role: 'trader';
  username: string;
  markets: Market[];
  strategySummary: string;
  commissionPct: number;
  minCapitalTRY: number;
}

/**
 * BE-01: rolün ayırt edici alan olduğu birleşik gövde. Cüzdan adresi gövdede gönderilmez;
 * backend SEP-10 JWT'sinden okur.
 */
export type RegisterPayload = CustomerRegisterPayload | TraderRegisterPayload;

export const profileApi = {
  me: () => http.get<UserProfile>(`${V1}/profile`),
  register: (payload: RegisterPayload) => http.post<UserProfile>(`${V1}/register`, payload),
};

// --- İlanlar ---
export const listingsApi = {
  discover: (params?: { kind?: Listing['kind']; cursor?: string }) =>
    http.get<{ items: Listing[]; nextCursor?: string }>(`${V1}/listings`, params),
  byId: (id: string) => http.get<Listing>(`${V1}/listings/${id}`),
  mine: () => http.get<Listing[]>(`${V1}/my/listings`),
  create: (payload: Partial<Listing>) => http.post<Listing>(`${V1}/listings`, payload),
  offers: (listingId: string) => http.get<Offer[]>(`${V1}/listings/${listingId}/offers`),
  /**
   * BE-03 önerisi (Keşfet sağa kaydırma):
   * müşteri hizmet ilanına teklif ister, trader müşteri ilanına teklif verir.
   */
  requestOffer: (listingId: string, note?: string) =>
    http.post<Offer>(`${V1}/listings/${listingId}/requests`, { note }),
  /** Trader'ın müşteri ilanına teklifi (Keşfet · Trader → "Teklif Ver" sheet). */
  createOffer: (
    listingId: string,
    payload: { commissionPct: number; expectedReturnRange: [number, number]; note?: string },
  ) => http.post<Offer>(`${V1}/listings/${listingId}/offers`, payload),
  /** İlanı daha sonra bakmak üzere kaydeder (Keşfet · Trader "Kaydet"). */
  save: (listingId: string) => http.post<{ ok: true }>(`${V1}/listings/${listingId}/saves`),
};

// --- Takip ---
export const followApi = {
  follow: (traderAddress: string) => http.post<{ ok: true }>(`${V1}/follow`, { traderAddress }),
  list: () => http.get<UserProfile[]>(`${V1}/follows`),
};

// --- Sözleşmeler (escrow yansıması) ---
export const contractsApi = {
  list: () => http.get<RentalContract[]>(`${V1}/contracts`),
  byId: (id: string) => http.get<RentalContract>(`${V1}/contracts/${id}`),
};

// --- İşlemler / hareketler ---
export const tradesApi = {
  feed: (params?: { traderAddress?: string; status?: Trade['status'] }) =>
    http.get<Trade[]>(`${V1}/transactions`, params),
  create: (payload: Omit<Trade, 'id' | 'traderAddress' | 'openedAt' | 'status'>) =>
    http.post<Trade>(`${V1}/transactions`, payload),
};

// --- Anchor (SEP-24) — backend interactive URL üretir ---
export const anchorApi = {
  deposit: (amountTRY: number) =>
    http.post<{ url: string; id: string }>(`${V1}/anchor/deposit`, { amountTRY }),
  withdraw: (amountTRY: number) =>
    http.post<{ url: string; id: string }>(`${V1}/anchor/withdraw`, { amountTRY }),
  status: (id: string) => http.get<WalletTransaction>(`${V1}/anchor/status/${id}`),
  history: () => http.get<WalletTransaction[]>(`${V1}/anchor/history`),
};

// --- İmzalı XDR gönderimi (Relayer) ---
export const txApi = {
  submit: (signedXdr: string) =>
    http.post<{ hash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }>(`${V1}/tx/submit`, {
      xdr: signedXdr,
    }),
};

// --- Mesajlar & bildirimler ---
export const messagesApi = {
  threads: () => http.get<MessageThread[]>(`${V1}/messages`),
  thread: (threadId: string) => http.get<Message[]>(`${V1}/messages/${threadId}`),
  send: (threadId: string, text: string) =>
    http.post<Message>(`${V1}/messages`, { threadId, text }),
};

export const notificationsApi = {
  list: () => http.get<AppNotification[]>(`${V1}/notifications`),
  markAllRead: () => http.post<{ ok: true }>(`${V1}/notifications/read-all`),
};
