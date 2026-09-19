import { http } from './client';
import type {
  AssetOut,
  AuthMeOut,
  ConfigOut,
  DiscoverActionOut,
  DiscoverFeedOut,
  FollowOut,
  InteractionAction,
  InteractionTargetType,
  ListingKind,
  ListingOut,
  LoginOut,
  MeOut,
  OfferCreateIn,
  OfferOut,
  RegisterIn,
  Sep10ChallengeOut,
} from './types';

/**
 * TraderKirala API — <https://mobilback.yolalapp.com> (92 uç, şema: /docs).
 * Tüm uçlar `/api/v1` öneki altında; `/health` önek dışındadır.
 * Tipler `./types.ts` içinde sunucu şemasıyla birebir.
 */
const V1 = '/api/v1';

// --- Meta ---
export const metaApi = {
  /** Ağ, passphrase, RPC/Horizon, vault kontrat kimliği, auth ayarları. */
  config: () => http.get<ConfigOut>(`${V1}/config`, undefined, false),
  health: () =>
    http.get<{ status: string; db?: string; version?: string }>('/health', undefined, false),
  assets: () => http.get<AssetOut[]>(`${V1}/assets`),
};

// --- Kimlik doğrulama (SEP-10) ---
export const authApi = {
  /** Challenge XDR üretir. Cüzdan bunu imzalar. */
  sep10Challenge: (account: string, memo?: string) =>
    http.get<Sep10ChallengeOut>(`${V1}/auth/sep10`, { account, memo }, false),
  /** İmzalı challenge → JWT + kayıt durumu. */
  sep10Verify: (transaction: string) =>
    http.post<LoginOut>(`${V1}/auth/sep10`, { transaction }, false),
  /** Mesaj imzalayan cüzdanlar için alternatif: nonce al. */
  nonce: (publicKey: string) =>
    http.post<{ nonce: string; message: string; expires_at: string }>(
      `${V1}/auth/nonce`,
      { public_key: publicKey },
      false,
    ),
  /** Nonce mesajının base64 ed25519 imzası ile giriş. */
  verifyNonce: (payload: { public_key: string; nonce: string; signature: string }) =>
    http.post<LoginOut>(`${V1}/auth/verify`, payload, false),
  me: () => http.get<AuthMeOut>(`${V1}/auth/me`),
  /** JWT süresi dolmadan yenile — cüzdanda yeni imza istemez. */
  refresh: () => http.post<LoginOut>(`${V1}/auth/refresh`),
};

// --- Kullanıcı & profil ---
export const usersApi = {
  register: (payload: RegisterIn) => http.post<MeOut>(`${V1}/users/register`, payload),
  me: () => http.get<MeOut>(`${V1}/users/me`),
  updateMe: (payload: Partial<RegisterIn>) => http.patch<MeOut>(`${V1}/users/me`, payload),
  byUsername: (username: string) => http.get<MeOut>(`${V1}/users/by-username/${username}`),
};

// --- Keşfet ---
export const discoverApi = {
  /** Rol'e göre sunucu tarafında seçilen kart akışı (müşteriye hizmet, trader'a sermaye ilanları). */
  feed: (params?: { limit?: number; cursor?: string; market?: string }) =>
    http.get<DiscoverFeedOut>(`${V1}/discover`, params),
  remaining: () => http.get<{ remaining: number }>(`${V1}/discover/remaining`),
  /** pass | like | save | follow | view | offer_request */
  action: (targetType: InteractionTargetType, targetId: string, action: InteractionAction) =>
    http.post<DiscoverActionOut>(`${V1}/discover/${targetType}/${targetId}/action`, { action }),
  unsaveListing: (listingId: string) =>
    http.delete<{ ok: boolean }>(`${V1}/discover/listing/${listingId}/save`),
};

// --- İlanlar ---
export const listingsApi = {
  list: (params?: { kind?: ListingKind; cursor?: string; limit?: number }) =>
    http.get<{ items: ListingOut[]; next_cursor?: string | null }>(`${V1}/listings`, params),
  mine: () => http.get<{ items: ListingOut[] }>(`${V1}/listings/mine`),
  mineCounts: () => http.get<Record<string, number>>(`${V1}/listings/mine/counts`),
  saved: () => http.get<{ items: ListingOut[] }>(`${V1}/listings/saved`),
  byId: (id: string) => http.get<ListingOut>(`${V1}/listings/${id}`),
  create: (payload: Record<string, unknown>) => http.post<ListingOut>(`${V1}/listings`, payload),
  pause: (id: string) => http.post<ListingOut>(`${V1}/listings/${id}/pause`),
  resume: (id: string) => http.post<ListingOut>(`${V1}/listings/${id}/resume`),
  close: (id: string) => http.post<ListingOut>(`${V1}/listings/${id}/close`),
};

// --- Teklifler ---
export const offersApi = {
  create: (payload: OfferCreateIn) => http.post<OfferOut>(`${V1}/offers`, payload),
  list: (params?: { status?: string; role?: string }) =>
    http.get<{ items: OfferOut[] }>(`${V1}/offers`, params),
  byId: (id: string) => http.get<OfferOut>(`${V1}/offers/${id}`),
  accept: (id: string) => http.post<OfferOut>(`${V1}/offers/${id}/accept`),
  reject: (id: string) => http.post<OfferOut>(`${V1}/offers/${id}/reject`),
  withdraw: (id: string) => http.post<OfferOut>(`${V1}/offers/${id}/withdraw`),
  stats: () => http.get<Record<string, number>>(`${V1}/offers/stats`),
};

// --- Trader'lar ---
export const tradersApi = {
  list: (params?: { cursor?: string; limit?: number }) =>
    http.get<{ items: MeOut[] }>(`${V1}/traders`, params),
  profile: (traderId: string) => http.get<MeOut>(`${V1}/traders/${traderId}/profile`),
  follow: (traderId: string) => http.post<FollowOut>(`${V1}/traders/${traderId}/follow`),
  unfollow: (traderId: string) => http.delete<FollowOut>(`${V1}/traders/${traderId}/follow`),
  ratings: (traderId: string) =>
    http.get<{ items: unknown[] }>(`${V1}/traders/${traderId}/ratings`),
};

// --- Panel & hareketler ---
export const dashboardApi = {
  get: () => http.get<Record<string, unknown>>(`${V1}/dashboard`),
};

export const activityApi = {
  feed: (params?: { cursor?: string; limit?: number }) =>
    http.get<{ items: unknown[]; next_cursor?: string | null }>(`${V1}/activity`, params),
};

// --- Sözleşmeler (agreements) ---
export const agreementsApi = {
  list: (params?: { status?: string }) =>
    http.get<{ items: unknown[] }>(`${V1}/agreements`, params),
  byId: (id: string) => http.get<Record<string, unknown>>(`${V1}/agreements/${id}`),
  quote: (id: string) => http.get<Record<string, unknown>>(`${V1}/agreements/${id}/quote`),
  trades: (id: string) => http.get<{ items: unknown[] }>(`${V1}/agreements/${id}/trades`),
  valueHistory: (id: string) =>
    http.get<{ items: unknown[] }>(`${V1}/agreements/${id}/value-history`),
  /** Zincir üstü işlem XDR'ı üretir (fund / settle / cancel …). */
  buildTx: (id: string, action: string, payload?: Record<string, unknown>) =>
    http.post<{ xdr: string; pending_id?: string }>(`${V1}/agreements/${id}/tx/${action}`, payload),
  buildTradeTx: (id: string, payload: Record<string, unknown>) =>
    http.post<{ xdr: string; pending_id?: string }>(`${V1}/agreements/${id}/tx/trade`, payload),
  rate: (id: string, payload: Record<string, unknown>) =>
    http.post<Record<string, unknown>>(`${V1}/agreements/${id}/rating`, payload),
};

// --- İmzalı işlem gönderimi ---
export const txApi = {
  submit: (signedXdr: string, pendingId?: string) =>
    http.post<{ hash?: string; status: string }>(`${V1}/tx/submit`, {
      xdr: signedXdr,
      pending_id: pendingId,
    }),
  status: (pendingId: string) =>
    http.get<{ status: string; hash?: string }>(`${V1}/tx/${pendingId}`),
};

// --- Mesajlar ---
export const conversationsApi = {
  list: () => http.get<{ items: unknown[] }>(`${V1}/conversations`),
  unreadCount: () => http.get<{ count: number }>(`${V1}/conversations/unread-count`),
  byId: (id: string) => http.get<Record<string, unknown>>(`${V1}/conversations/${id}`),
  messages: (id: string, params?: { cursor?: string }) =>
    http.get<{ items: unknown[] }>(`${V1}/conversations/${id}/messages`, params),
  send: (id: string, body: string) =>
    http.post<Record<string, unknown>>(`${V1}/conversations/${id}/messages`, { body }),
  markRead: (id: string) => http.post<{ ok: boolean }>(`${V1}/conversations/${id}/read`),
};

// --- Bildirimler ---
export const notificationsApi = {
  list: (params?: { cursor?: string }) =>
    http.get<{ items: unknown[]; next_cursor?: string | null }>(`${V1}/notifications`, params),
  unreadCount: () => http.get<{ count: number }>(`${V1}/notifications/unread-count`),
  markAllRead: () => http.post<{ ok: boolean }>(`${V1}/notifications/read`),
  markRead: (id: string) => http.post<{ ok: boolean }>(`${V1}/notifications/${id}/read`),
  setPushToken: (token: string) =>
    http.put<{ ok: boolean }>(`${V1}/notifications/push-token`, { expo_push_token: token }),
};

// --- Cüzdan & anchor ---
export const walletApi = {
  get: () => http.get<Record<string, unknown>>(`${V1}/wallet`),
  depositInfo: () => http.get<Record<string, unknown>>(`${V1}/wallet/deposit-info`),
  buildPaymentTx: (payload: Record<string, unknown>) =>
    http.post<{ xdr: string }>(`${V1}/wallet/tx/payment`, payload),
  buildTrustlineTx: (payload: Record<string, unknown>) =>
    http.post<{ xdr: string }>(`${V1}/wallet/tx/trustline`, payload),
};

export const anchorApi = {
  info: () => http.get<Record<string, unknown>>(`${V1}/anchor/info`),
  session: () => http.get<Record<string, unknown>>(`${V1}/anchor/auth/session`),
  deposit: (payload: Record<string, unknown>) =>
    http.post<{ url?: string; id?: string }>(`${V1}/anchor/deposit`, payload),
  withdraw: (payload: Record<string, unknown>) =>
    http.post<{ url?: string; id?: string }>(`${V1}/anchor/withdraw`, payload),
  transactions: () => http.get<{ items: unknown[] }>(`${V1}/anchor/transactions`),
  transaction: (ref: string) =>
    http.get<Record<string, unknown>>(`${V1}/anchor/transactions/${ref}`),
};

// --- Kur ---
export const fxApi = {
  rates: () => http.get<Record<string, unknown>>(`${V1}/fx`, undefined, false),
  convert: (params: { amount: number | string; from: string; to: string }) =>
    http.get<Record<string, unknown>>(`${V1}/fx/convert`, params, false),
};
