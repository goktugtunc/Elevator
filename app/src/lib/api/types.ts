/**
 * Sunucu şemaları — <https://mobilback.yolalapp.com/openapi.json> ile birebir.
 * Alan adları sunucudaki gibi snake_case bırakıldı; biçimlendirme
 * `src/lib/format.ts` (bps → %, string tutar → okunur metin) ile yapılır.
 *
 * Para alanları **string** (ondalık kayıp olmasın diye), oranlar **bps**
 * (basis point: 2000 = %20).
 */

export type UserRole = 'customer' | 'trader';
export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ListingKind = 'capital' | 'service';
export type ListingStatus = 'active' | 'paused' | 'closed';
export type MarketCategory = 'crypto' | 'stable_fx' | 'defi';
export type InteractionAction = 'pass' | 'like' | 'save' | 'follow' | 'view' | 'offer_request';
export type InteractionTargetType = 'listing' | 'user';
export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';
export type AgreementStatus =
  'draft' | 'proposed' | 'funded' | 'active' | 'settled' | 'cancelled' | 'failed';

export interface AuthConfigOut {
  login_message_prefix: string;
  auth_nonce_ttl_seconds: number;
  access_token_ttl_seconds: number;
  sep10_challenge_timeout: number;
}

export interface ConfigOut {
  version: string;
  network: string;
  network_passphrase: string;
  horizon_url: string;
  soroban_rpc_url: string | null;
  friendbot_url: string | null;
  home_domain: string;
  web_auth_domain: string;
  web_auth_endpoint: string;
  signing_key: string;
  platform_account: string;
  api_prefix: string;
  vault_contract_id: string | null;
  soroswap_router_id: string;
  default_base_asset_code: string;
  platform_fee_bps: number | null;
  auth: AuthConfigOut;
  assets?: AssetOut[];
}

export interface TraderStats {
  total_return_bps: number;
  monthly_return_bps: number;
  max_drawdown_bps: number;
  win_rate_bps: number;
  managed_capital: string;
  active_agreements: number;
  rating_avg: string;
  rating_count: number;
}

export interface UserOut {
  id: string;
  stellar_address: string;
  role: UserRole;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  markets: string[];
  created_at: string;
  budget_amount: string | null;
  risk_profile: RiskProfile | null;
  strategy_summary: string | null;
  commission_bps: number | null;
  min_capital: string | null;
  risk_level: RiskLevel | null;
  stats: TraderStats | null;
}

export interface MeOut extends UserOut {
  expo_push_token?: string | null;
  is_admin?: boolean;
  is_active?: boolean;
  last_login_at?: string | null;
  updated_at?: string | null;
}

/** `/auth/sep10` (POST), `/auth/verify`, `/auth/refresh` ortak yanıtı. */
export interface LoginOut {
  token: string;
  expires_at: string;
  public_key: string;
  /** false ise kullanıcı henüz `POST /users/register` yapmamış. */
  registered: boolean;
  user: MeOut | null;
}

export interface AuthMeOut {
  public_key: string;
  registered: boolean;
  user: MeOut | null;
  token_expires_at: string;
}

export interface Sep10ChallengeOut {
  transaction: string;
  network_passphrase: string;
}

export interface AssetOut {
  id: string;
  network: string;
  contract_id: string;
  code: string;
  issuer: string | null;
  decimals: number;
  name: string;
  icon_url: string | null;
  category: MarketCategory;
  is_base_allowed: boolean;
  is_active: boolean;
  is_native: boolean;
  canonical: string;
}

export interface ListingOut {
  id: string;
  owner_id: string;
  owner: UserOut;
  kind: ListingKind;
  title: string;
  description: string;
  risk_profile: RiskProfile | null;
  markets: string[];
  status: ListingStatus;
  amount: string | null;
  base_asset_id: string | null;
  base_asset: AssetOut | null;
  duration_days: number | null;
  max_loss_bps: number | null;
  commission_bps: number | null;
  min_capital: string | null;
  expected_return_min_bps: number | null;
  expected_return_max_bps: number | null;
  view_count: number;
  like_count: number;
  offer_count: number;
  created_at: string;
  is_owner: boolean | null;
  is_saved: boolean | null;
  is_liked: boolean | null;
}

export interface DiscoverCardOut {
  target_type: InteractionTargetType;
  target_id: string;
  owner_target_id: string;
  kind: ListingKind;
  listing: ListingOut;
  is_following: boolean;
  is_saved: boolean;
  tags: string[];
}

export interface DiscoverFeedOut {
  items: DiscoverCardOut[];
  next_cursor: string | null;
  remaining: number;
  kind: ListingKind;
}

export interface DiscoverActionOut {
  target_type: InteractionTargetType;
  target_id: string;
  action: InteractionAction;
  created: boolean;
  remaining: number;
  following: boolean | null;
  saved: boolean | null;
  like_count: number | null;
}

export interface CustomerProfileIn {
  budget_amount: string;
  risk_profile: RiskProfile;
  /** 1–3 adet */
  markets: MarketCategory[];
}

export interface TraderProfileIn {
  markets: MarketCategory[];
  strategy_summary: string;
  commission_bps: number;
  min_capital: string;
  risk_level: RiskLevel;
}

export interface RegisterIn {
  role: UserRole;
  username: string;
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
  customer?: CustomerProfileIn | null;
  trader?: TraderProfileIn | null;
}

export interface OfferCreateIn {
  listing_id: string;
  amount: string;
  base_asset_id?: string | null;
  duration_days: number;
  commission_bps: number;
  max_drawdown_bps?: number | null;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
  note?: string | null;
  expires_in_hours?: number | null;
}

export interface OfferOut {
  id: string;
  listing_id: string;
  status: OfferStatus;
  amount: string;
  commission_bps: number;
  created_at: string;
}

export interface FollowOut {
  trader_id: string;
  following: boolean;
}
