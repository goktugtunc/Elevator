import { http } from './client';
import type {
  AgreementOut,
  AnchorInfoOut,
  AnchorSessionOut,
  AnchorTransactionListOut,
  AnchorTransactionOut,
  AssetOut,
  AuthMeOut,
  ActivityItemOut,
  ConfigOut,
  ConversationOut,
  ConversationsUnreadOut,
  CustomerDashboardOut,
  DepositInfoOut,
  DiscoverActionOut,
  DiscoverFeedOut,
  DiscoverRemainingOut,
  FollowOut,
  FxOut,
  FxConvertOut,
  InteractionAction,
  InteractionTargetType,
  InteractiveOut,
  KycOut,
  ListingCountsOut,
  ListingCreateIn,
  ListingDetailOut,
  ListingKind,
  ListingOut,
  ListingUpdateIn,
  LoginOut,
  MarkReadOut,
  MarketCategory,
  MeOut,
  MessageOut,
  MessagesPageOut,
  NotificationCategory,
  NotificationOut,
  OfferAcceptOut,
  OfferCreateIn,
  OfferOut,
  OfferStatsOut,
  OfferStatus,
  Page,
  PendingTxOut,
  QuoteOut,
  RatingCreateIn,
  RatingCreatedOut,
  RatingOut,
  RegisterIn,
  RegisterOut,
  RiskLevel,
  RiskProfile,
  Sep10ChallengeOut,
  TraderCardOut,
  TraderDashboardOut,
  TraderProfileOut,
  TradeOut,
  TradeTxIn,
  TxSubmitOut,
  UnreadCountOut,
  UnsignedTxOut,
  UserOut,
  UserUpdateIn,
  ValueHistoryOut,
  WalletOut,
  WalletPaymentIn,
  TrustlineIn,
} from './types';

/**
 * TraderKirala API — <https://mobilback.yolalapp.com> (92 uç, şema: /openapi.json).
 * Tüm uçlar `/api/v1` öneki altında; `/health` önek dışındadır.
 *
 * Tipler `./schema.ts` içinde sunucunun OpenAPI şemasından üretilir; buradaki
 * imzalar yalnızca yol ve sorgu parametrelerini bağlar. Sayfalama **offset**
 * tabanlıdır (`limit` / `offset`), tek istisna Keşfet akışıdır (`cursor`).
 */
const V1 = '/api/v1';

/**
 * Offset tabanlı sayfalama — listelerin ortak parametreleri.
 * `interface` değil `type`: sorgu nesneleri `QueryParams` indeks imzasına ancak
 * tip takma adı olduklarında uyar.
 */
export type PageParams = {
  limit?: number;
  offset?: number;
};

// --- Meta ---
export const metaApi = {
  /** Ağ, passphrase, RPC/Horizon, vault kontrat kimliği, auth ayarları. */
  config: () => http.get<ConfigOut>(`${V1}/config`, undefined, false),
  health: () =>
    http.get<{ status: string; db?: string; version?: string }>('/health', undefined, false),
  assets: (params?: { base_only?: boolean; onchain_only?: boolean }) =>
    http.get<AssetOut[]>(`${V1}/assets`, params),
  asset: (assetId: string) => http.get<AssetOut>(`${V1}/assets/${assetId}`),
  /** Gösterim için USD → TRY vb. kurlar. */
  fx: () => http.get<FxOut>(`${V1}/fx`),
  fxConvert: (amountUsd: string | number) =>
    http.get<FxConvertOut>(`${V1}/fx/convert`, { amount_usd: amountUsd }),
};

// --- Kimlik doğrulama (SEP-10) ---
export const authApi = {
  /** Challenge XDR üretir. Cüzdan bunu imzalar. */
  sep10Challenge: (account: string, memo?: number) =>
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
  /** Profil **ve rolü taşıyan yeni token** döndürür; token saklanmalıdır. */
  register: (payload: RegisterIn) => http.post<RegisterOut>(`${V1}/users/register`, payload),
  me: () => http.get<MeOut>(`${V1}/users/me`),
  updateMe: (payload: UserUpdateIn) => http.patch<MeOut>(`${V1}/users/me`, payload),
  byUsername: (username: string) => http.get<UserOut>(`${V1}/users/by-username/${username}`),
  byId: (userId: string) => http.get<UserOut>(`${V1}/users/${userId}`),
};

// --- Keşfet ---
export const discoverApi = {
  /** Rol'e göre sunucu tarafında seçilen kart akışı (tek cursor'lı uç). */
  feed: (params?: { limit?: number; cursor?: string; market?: MarketCategory }) =>
    http.get<DiscoverFeedOut>(`${V1}/discover`, params),
  remaining: (market?: MarketCategory) =>
    http.get<DiscoverRemainingOut>(`${V1}/discover/remaining`, { market }),
  /** pass | like | save | follow | view | offer_request */
  action: (targetType: InteractionTargetType, targetId: string, action: InteractionAction) =>
    http.post<DiscoverActionOut>(`${V1}/discover/${targetType}/${targetId}/action`, { action }),
  unsaveListing: (listingId: string) =>
    http.delete<{ ok: boolean }>(`${V1}/discover/listing/${listingId}/save`),
};

// --- İlanlar ---
export const listingsApi = {
  list: (
    params?: PageParams & {
      kind?: ListingKind;
      market?: MarketCategory;
      risk_profile?: RiskProfile;
      q?: string;
      sort?: 'newest' | 'popular' | 'amount';
    },
  ) => http.get<Page<ListingOut>>(`${V1}/listings`, params),
  mine: (params?: PageParams & { status?: string }) =>
    http.get<Page<ListingOut>>(`${V1}/listings/mine`, params),
  mineCounts: () => http.get<ListingCountsOut>(`${V1}/listings/mine/counts`),
  saved: (params?: PageParams) => http.get<Page<ListingOut>>(`${V1}/listings/saved`, params),
  byId: (id: string) => http.get<ListingDetailOut>(`${V1}/listings/${id}`),
  create: (payload: ListingCreateIn) => http.post<ListingOut>(`${V1}/listings`, payload),
  update: (id: string, payload: ListingUpdateIn) =>
    http.patch<ListingOut>(`${V1}/listings/${id}`, payload),
  pause: (id: string) => http.post<ListingOut>(`${V1}/listings/${id}/pause`),
  resume: (id: string) => http.post<ListingOut>(`${V1}/listings/${id}/resume`),
  close: (id: string) => http.post<ListingOut>(`${V1}/listings/${id}/close`),
};

// --- Teklifler ---
export const offersApi = {
  create: (payload: OfferCreateIn) => http.post<OfferOut>(`${V1}/offers`, payload),
  /** `box`: inbox = bana gelenler, outbox = benim gönderdiklerim. */
  list: (
    params?: PageParams & {
      box?: 'inbox' | 'outbox' | 'all';
      status?: OfferStatus;
      listing_id?: string;
    },
  ) => http.get<Page<OfferOut>>(`${V1}/offers`, params),
  byId: (id: string) => http.get<OfferOut>(`${V1}/offers/${id}`),
  /** Kabul, taslak sözleşmeyi (`agreement`) doğurur. */
  accept: (id: string) => http.post<OfferAcceptOut>(`${V1}/offers/${id}/accept`),
  reject: (id: string, reason?: string) =>
    http.post<OfferOut>(`${V1}/offers/${id}/reject`, { reason }),
  withdraw: (id: string) => http.post<OfferOut>(`${V1}/offers/${id}/withdraw`),
  stats: () => http.get<OfferStatsOut>(`${V1}/offers/stats`),
};

// --- Trader'lar ---
export const tradersApi = {
  list: (
    params?: PageParams & {
      sort?: 'rating' | 'return' | 'capital' | 'followers' | 'newest';
      market?: MarketCategory;
      risk_level?: RiskLevel;
      q?: string;
    },
  ) => http.get<Page<TraderCardOut>>(`${V1}/traders`, params),
  profile: (traderId: string, params?: { range?: '7d' | '30d' | '90d' | '1y' | 'all'; trades?: number }) =>
    http.get<TraderProfileOut>(`${V1}/traders/${traderId}/profile`, params),
  follow: (traderId: string) => http.post<FollowOut>(`${V1}/traders/${traderId}/follow`),
  unfollow: (traderId: string) => http.delete<FollowOut>(`${V1}/traders/${traderId}/follow`),
  ratings: (traderId: string, params?: PageParams) =>
    http.get<Page<RatingOut>>(`${V1}/traders/${traderId}/ratings`, params),
};

// --- Panel & hareketler ---
export const dashboardApi = {
  /** Rol'e göre sunucu iki farklı gövdeden birini döndürür (`role` ayırt eder). */
  get: () => http.get<TraderDashboardOut | CustomerDashboardOut>(`${V1}/dashboard`),
};

export const activityApi = {
  feed: (params?: PageParams & { trader_id?: string; state?: 'open' | 'closed' }) =>
    http.get<Page<ActivityItemOut>>(`${V1}/activity`, params),
};

// --- Sözleşmeler (agreements) ---
export const agreementsApi = {
  list: (params?: PageParams & { role?: string; status?: string }) =>
    http.get<Page<AgreementOut>>(`${V1}/agreements`, params),
  byId: (id: string, refresh?: boolean) =>
    http.get<AgreementOut>(`${V1}/agreements/${id}`, { refresh }),
  quote: (
    id: string,
    params: {
      token_in: string;
      token_out: string;
      amount_in: string;
      slippage_bps?: number;
      deadline_seconds?: number;
    },
  ) => http.get<QuoteOut>(`${V1}/agreements/${id}/quote`, params),
  trades: (id: string, params?: PageParams) =>
    http.get<Page<TradeOut>>(`${V1}/agreements/${id}/trades`, params),
  valueHistory: (id: string, range?: '24h' | '7d' | '30d' | '90d' | 'all') =>
    http.get<ValueHistoryOut>(`${V1}/agreements/${id}/value-history`, { range }),
  /** Zincir üstü işlem XDR'ı üretir: open | propose | fund | accept | cancel | settle. */
  buildTx: (id: string, action: string, payload?: Record<string, unknown>) =>
    http.post<UnsignedTxOut>(`${V1}/agreements/${id}/tx/${action}`, payload ?? {}),
  buildTradeTx: (id: string, payload: TradeTxIn) =>
    http.post<UnsignedTxOut>(`${V1}/agreements/${id}/tx/trade`, payload),
  rate: (id: string, payload: RatingCreateIn) =>
    http.post<RatingCreatedOut>(`${V1}/agreements/${id}/rating`, payload),
  rating: (id: string) => http.get<RatingOut>(`${V1}/agreements/${id}/rating`),
};

export const tradesApi = {
  /** Yalnızca not/görünürlük güncellenir; işlemin kendisi zincirdedir. */
  update: (tradeId: string, payload: { note?: string | null }) =>
    http.patch<TradeOut>(`${V1}/trades/${tradeId}`, payload),
};

// --- İmzalı işlem gönderimi ---
export const txApi = {
  submit: (signedXdr: string, pendingId?: string) =>
    http.post<TxSubmitOut>(`${V1}/tx/submit`, { xdr: signedXdr, pending_id: pendingId }),
  status: (pendingId: string) => http.get<PendingTxOut>(`${V1}/tx/${pendingId}`),
};

// --- Mesajlar ---
export const conversationsApi = {
  list: (params?: PageParams) => http.get<Page<ConversationOut>>(`${V1}/conversations`, params),
  /** Teklife bağlı olmayan doğrudan sohbet açar; varsa mevcut olanı döner (idempotent). */
  start: (userId: string) =>
    http.post<ConversationOut>(`${V1}/conversations`, { user_id: userId }),
  unreadCount: () => http.get<ConversationsUnreadOut>(`${V1}/conversations/unread-count`),
  byId: (id: string) => http.get<ConversationOut>(`${V1}/conversations/${id}`),
  messages: (id: string, params?: { after?: string; before?: string; limit?: number }) =>
    http.get<MessagesPageOut>(`${V1}/conversations/${id}/messages`, params),
  send: (id: string, body: string) =>
    http.post<MessageOut>(`${V1}/conversations/${id}/messages`, { body }),
  markRead: (id: string) => http.post<MarkReadOut>(`${V1}/conversations/${id}/read`),
};

// --- Bildirimler ---
export const notificationsApi = {
  list: (params?: PageParams & { category?: NotificationCategory; unread_only?: boolean }) =>
    http.get<Page<NotificationOut>>(`${V1}/notifications`, params),
  byId: (id: string) => http.get<NotificationOut>(`${V1}/notifications/${id}`),
  unreadCount: () => http.get<UnreadCountOut>(`${V1}/notifications/unread-count`),
  markAllRead: (ids?: string[]) => http.post<MarkReadOut>(`${V1}/notifications/read`, { ids }),
  markRead: (id: string) => http.post<MarkReadOut>(`${V1}/notifications/${id}/read`),
  setPushToken: (token: string) =>
    http.put<{ ok: boolean }>(`${V1}/notifications/push-token`, { expo_push_token: token }),
};

// --- Cüzdan & anchor ---
export const walletApi = {
  /** `movements`: kaç son hareket döneceği (1-100, varsayılan 20) — bayrak değil. */
  get: (movements?: number) => http.get<WalletOut>(`${V1}/wallet`, { movements }),
  depositInfo: () => http.get<DepositInfoOut>(`${V1}/wallet/deposit-info`),
  buildPaymentTx: (payload: WalletPaymentIn) =>
    http.post<UnsignedTxOut>(`${V1}/wallet/tx/payment`, payload),
  buildTrustlineTx: (payload: TrustlineIn) =>
    http.post<UnsignedTxOut>(`${V1}/wallet/tx/trustline`, payload),
};

export const anchorApi = {
  info: (lang?: string) => http.get<AnchorInfoOut>(`${V1}/anchor/info`, { lang }),
  session: () => http.get<AnchorSessionOut>(`${V1}/anchor/auth/session`),
  /** SEP-24 interactive URL döner; `expo-web-browser` ile açılır. */
  deposit: (payload: Record<string, unknown>) =>
    http.post<InteractiveOut>(`${V1}/anchor/deposit`, payload),
  withdraw: (payload: Record<string, unknown>) =>
    http.post<InteractiveOut>(`${V1}/anchor/withdraw`, payload),
  kyc: (payload: Record<string, unknown>) => http.post<KycOut>(`${V1}/anchor/kyc`, payload),
  transactions: (
    params?: PageParams & {
      kind?: 'deposit' | 'withdraw';
      status?: string;
      asset_code?: string;
      sync?: boolean;
    },
  ) => http.get<AnchorTransactionListOut>(`${V1}/anchor/transactions`, params),
  transaction: (ref: string, refresh?: boolean) =>
    http.get<AnchorTransactionOut>(`${V1}/anchor/transactions/${ref}`, { refresh }),
  /** Çekimde anchor'a yapılacak ödemenin XDR'ı. */
  buildWithdrawPaymentTx: (ref: string, payload?: Record<string, unknown>) =>
    http.post<UnsignedTxOut>(`${V1}/anchor/transactions/${ref}/tx/payment`, payload ?? {}),
};
