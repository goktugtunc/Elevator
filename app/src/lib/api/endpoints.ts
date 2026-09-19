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
 * Backend OpenAPI şemasını yayınladığında tipler buradan güncellenir.
 * Sahte veri YOK: endpoint hazır değilse ekran "hazırlanıyor" durumu gösterir.
 */

// --- Auth (SEP-10) ---
export const authApi = {
  challenge: (address: string) =>
    http.post<{ transaction: string; networkPassphrase: string }>(
      '/auth/challenge',
      { account: address },
      false,
    ),
  verify: (signedTransaction: string) =>
    http.post<{ token: string; expiresAt?: string }>(
      '/auth/verify',
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
  me: () => http.get<UserProfile>('/profile'),
  register: (payload: RegisterPayload) => http.post<UserProfile>('/register', payload),
};

// --- İlanlar ---
export const listingsApi = {
  discover: (params?: { kind?: Listing['kind']; cursor?: string }) =>
    http.get<{ items: Listing[]; nextCursor?: string }>('/listings', params),
  byId: (id: string) => http.get<Listing>(`/listings/${id}`),
  mine: () => http.get<Listing[]>('/my/listings'),
  create: (payload: Partial<Listing>) => http.post<Listing>('/listings', payload),
  offers: (listingId: string) => http.get<Offer[]>(`/listings/${listingId}/offers`),
  /**
   * BE-03 önerisi (Keşfet sağa kaydırma):
   * müşteri hizmet ilanına teklif ister, trader müşteri ilanına teklif verir.
   */
  requestOffer: (listingId: string, note?: string) =>
    http.post<Offer>(`/listings/${listingId}/requests`, { note }),
};

// --- Takip ---
export const followApi = {
  follow: (traderAddress: string) => http.post<{ ok: true }>('/follow', { traderAddress }),
  list: () => http.get<UserProfile[]>('/follows'),
};

// --- Sözleşmeler (escrow yansıması) ---
export const contractsApi = {
  list: () => http.get<RentalContract[]>('/contracts'),
  byId: (id: string) => http.get<RentalContract>(`/contracts/${id}`),
};

// --- İşlemler / hareketler ---
export const tradesApi = {
  feed: (params?: { traderAddress?: string; status?: Trade['status'] }) =>
    http.get<Trade[]>('/transactions', params),
  create: (payload: Omit<Trade, 'id' | 'traderAddress' | 'openedAt' | 'status'>) =>
    http.post<Trade>('/transactions', payload),
};

// --- Anchor (SEP-24) — backend interactive URL üretir ---
export const anchorApi = {
  deposit: (amountTRY: number) =>
    http.post<{ url: string; id: string }>('/anchor/deposit', { amountTRY }),
  withdraw: (amountTRY: number) =>
    http.post<{ url: string; id: string }>('/anchor/withdraw', { amountTRY }),
  status: (id: string) => http.get<WalletTransaction>(`/anchor/status/${id}`),
  history: () => http.get<WalletTransaction[]>('/anchor/history'),
};

// --- İmzalı XDR gönderimi (Relayer) ---
export const txApi = {
  submit: (signedXdr: string) =>
    http.post<{ hash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }>('/tx/submit', {
      xdr: signedXdr,
    }),
};

// --- Mesajlar & bildirimler ---
export const messagesApi = {
  threads: () => http.get<MessageThread[]>('/messages'),
  thread: (threadId: string) => http.get<Message[]>(`/messages/${threadId}`),
  send: (threadId: string, text: string) => http.post<Message>('/messages', { threadId, text }),
};

export const notificationsApi = {
  list: () => http.get<AppNotification[]>('/notifications'),
  markAllRead: () => http.post<{ ok: true }>('/notifications/read-all'),
};
