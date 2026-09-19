// Bu dosya üretildi — elle düzenlemeyin.
// Kaynak: https://mobilback.yolalapp.com/openapi.json
// Yeniden üretmek için: npm run gen:api

/** Sunucunun sayfalı yanıt zarfı (`Page[T]`) — offset tabanlı, cursor yok. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ActivityItemOut {
  trade: TradeOut;
  agreement_status: AgreementStatus;
  base_asset_code: string;
  trader: PartyOut;
  /** only when the viewer is a party */
  customer?: PartyOut | null;
  relation: "party" | "following";
}

/** The off-chain `agreements` row created by accepting an offer (status `draft`, nothing on-chain ye… */
export interface AgreementDraftOut {
  id: string;
  onchain_id?: number | null;
  offer_id?: string | null;
  listing_id?: string | null;
  customer_id: string;
  trader_id: string;
  customer: UserOut;
  trader: UserOut;
  base_asset_id: string;
  base_asset: AssetOut;
  principal: string;
  duration_secs: number;
  commission_bps: number;
  max_drawdown_bps: number;
  risk_profile?: RiskProfile | null;
  listing_ref: string;
  status: AgreementStatus;
  proposer_role: UserRole;
  created_at: string;
}

export interface AgreementOut {
  id: string;
  onchain_id?: number | null;
  offer_id?: string | null;
  listing_id?: string | null;
  status: AgreementStatus;
  proposer_role: UserRole;
  customer: PartyOut;
  trader: PartyOut;
  base_asset: AssetBriefOut;
  principal: string;
  duration_secs: number;
  duration_days: number;
  commission_bps: number;
  max_drawdown_bps: number;
  risk_profile?: RiskProfile | null;
  listing_ref: string;
  created_tx?: string | null;
  activate_tx?: string | null;
  cancel_tx?: string | null;
  settle_tx?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  seconds_remaining?: number | null;
  is_expired?: boolean;
  current_value?: string | null;
  value_updated_at?: string | null;
  high_water_value?: string | null;
  /** current (or final) value − principal */
  pnl?: string | null;
  pnl_bps?: number | null;
  /** principal × (1 − max_drawdown); trades below it are rejected */
  drawdown_floor: string;
  /** current drawdown from principal in bps (0 when in profit) */
  drawdown_bps?: number;
  final_value?: string | null;
  profit?: string | null;
  trader_fee?: string | null;
  platform_fee?: string | null;
  customer_payout?: string | null;
  settled_at?: string | null;
  settled_by?: string | null;
  last_event_ledger?: number | null;
  balances?: BalanceOut[];
  /** customer | trader | null (not a party) */
  my_role?: UserRole | null;
  /** tx actions the viewer may build now */
  available_actions?: string[];
  /** latest unfinished transaction of the viewer */
  pending_tx?: PendingTxBriefOut | null;
  tl?: TlOut | null;
  created_at: string;
  updated_at: string;
}

/** Off-chain mirror of the contract `Status` plus the pre/post-chain states. */
export type AgreementStatus = "draft" | "proposed" | "funded" | "active" | "settled" | "cancelled" | "failed";

export interface AnchorAssetOut {
  /** anchor asset code: `native` for XLM, otherwise the issued code */
  code: string;
  /** what the UI shows (`XLM` for native) */
  display_code: string;
  issuer?: string | null;
  /** issued asset: the account needs a trustline before a deposit */
  needs_trustline: boolean;
  deposit_enabled?: boolean;
  deposit_min?: string | null;
  deposit_max?: string | null;
  deposit_fee_fixed?: string | null;
  deposit_fee_percent?: string | null;
  withdraw_enabled?: boolean;
  withdraw_min?: string | null;
  withdraw_max?: string | null;
  withdraw_fee_fixed?: string | null;
  withdraw_fee_percent?: string | null;
  description?: string | null;
}

export interface AnchorConfigOut {
  enabled: boolean;
  home_domain: string;
  assets: string[];
  lang: string;
}

export interface AnchorFeaturesOut {
  account_creation?: boolean;
  claimable_balances?: boolean;
}

export interface AnchorInfoOut {
  enabled: boolean;
  home_domain: string;
  network_passphrase?: string | null;
  signing_key?: string | null;
  web_auth_endpoint?: string | null;
  web_auth_domain?: string | null;
  transfer_server_sep24?: string | null;
  kyc_server?: string | null;
  features?: AnchorFeaturesOut;
  assets?: AnchorAssetOut[];
  lang: string;
  session?: AnchorSessionOut | null;
  fetched_at?: string | null;
  /** set when the anchor could not be reached */
  error?: string | null;
}

/** State of the user's SEP-10 session with the anchor. The anchor JWT itself is never returned. */
export interface AnchorSessionOut {
  anchor_domain: string;
  authenticated: boolean;
  account?: string | null;
  expires_at?: string | null;
}

export interface AnchorTransactionListOut {
  items: AnchorTransactionOut[];
  total: number;
  /** false when the anchor could not be polled in this request */
  synced: boolean;
  /** true: run /anchor/auth/challenge + token again */
  auth_required?: boolean;
  sync_error?: string | null;
}

export interface AnchorTransactionOut {
  id: string;
  anchor_domain: string;
  anchor_tx_id: string;
  kind: AnchorTxKind;
  asset_code: string;
  asset_issuer?: string | null;
  amount_in?: string | null;
  amount_out?: string | null;
  amount_fee?: string | null;
  status: string;
  status_label: string;
  is_terminal: boolean;
  action: "open_interactive" | "send_payment" | "add_trustline" | "wait" | "none" | "retry";
  action_label: string;
  needs_reauth?: boolean;
  interactive_url?: string | null;
  more_info_url?: string | null;
  withdraw_anchor_account?: string | null;
  withdraw_memo?: string | null;
  withdraw_memo_type?: string | null;
  stellar_tx_hash?: string | null;
  external_tx_id?: string | null;
  message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type AnchorTxKind = "deposit" | "withdraw";

export interface AssetBriefOut {
  id: string;
  code: string;
  contract_id: string;
  issuer?: string | null;
  decimals?: number;
  name: string;
  icon_url?: string | null;
  category: MarketCategory;
}

export interface AssetOut {
  id: string;
  network: string;
  contract_id: string;
  code: string;
  issuer?: string | null;
  decimals?: number;
  name: string;
  icon_url?: string | null;
  category: MarketCategory;
  is_base_allowed: boolean;
  is_active: boolean;
  onchain_allowed?: boolean;
  created_at: string;
  is_native: boolean;
  is_classic: boolean;
  canonical: string;
}

export interface AuthConfigOut {
  login_message_prefix: string;
  auth_nonce_ttl_seconds: number;
  access_token_ttl_seconds: number;
  sep10_challenge_timeout: number;
}

export interface AuthMeOut {
  public_key: string;
  registered: boolean;
  user?: MeOut | null;
  token_expires_at: string;
}

export interface BalanceOut {
  asset: AssetBriefOut;
  balance: string;
  updated_at?: string | null;
  /** TL equivalent when a USD price is known */
  value_try?: string | null;
}

export interface ChallengeIn {
  /** optional SEP-10 ID memo */
  memo?: number | null;
}

/** A verified SEP-10 challenge. Sign it with the wallet key and POST it to /anchor/auth/token — NEVE… */
export interface ChallengeOut {
  /** base64 XDR of the anchor-signed challenge (verified by the backend) */
  transaction: string;
  network_passphrase: string;
  home_domain: string;
  web_auth_domain: string;
  /** anchor SIGNING_KEY that signed the challenge */
  signing_key: string;
  account: string;
  expires_at: string;
  instructions?: string;
}

export interface ConfigOut {
  version: string;
  network: string;
  network_passphrase: string;
  horizon_url: string;
  soroban_rpc_url?: string | null;
  friendbot_url?: string | null;
  home_domain: string;
  web_auth_domain: string;
  web_auth_endpoint: string;
  signing_key: string;
  platform_account: string;
  api_prefix: string;
  vault_contract_id?: string | null;
  soroswap_router_id: string;
  soroswap_api_url: string;
  default_base_asset_code: string;
  /** live from the contract; null when unreachable */
  platform_fee_bps?: number | null;
  settle_slippage_bps: number;
  default_trade_slippage_bps: number;
  tx_submit_timeout_seconds: number;
  limits: ContractLimits;
  contract?: ContractConfigOut | null;
  contract_error?: string | null;
  anchor: AnchorConfigOut;
  assets: AssetOut[];
  auth: AuthConfigOut;
  fx_cache_seconds: number;
  usd_prices?: Record<string, string | null>;
}

/** Live `get_config()` of the vault contract (read through the Soroban gateway). */
export interface ContractConfigOut {
  admin: string;
  router: string;
  platform_fee_bps: number;
  fee_recipient: string;
  paused: boolean;
  settle_slippage_bps: number;
}

/** Constants baked into the vault contract (DESIGN §1.1). */
export interface ContractLimits {
  max_tokens?: number;
  min_duration_days?: number;
  max_duration_days?: number;
  max_commission_bps?: number;
  max_platform_fee_bps?: number;
  min_drawdown_bps?: number;
  max_drawdown_bps?: number;
  max_settle_slippage_bps?: number;
}

export interface ConversationOut {
  id: string;
  offer_id?: string | null;
  agreement_id?: string | null;
  other_user: UserOut;
  last_message?: MessageOut | null;
  last_message_at?: string | null;
  unread_count?: number;
  created_at: string;
}

export interface ConversationReadOut {
  conversation_id: string;
  updated: number;
}

export interface ConversationsUnreadOut {
  /** threads with at least one unread message */
  conversations: number;
  messages: number;
}

export interface CustomerDashboardOut {
  role?: "customer";
  generated_at: string;
  base_asset_code: string;
  /** positions_value + wallet_balance (base asset units) */
  portfolio_value: string;
  /** live base-asset balance of the wallet */
  wallet_balance?: string | null;
  wallet_error?: string | null;
  invested_principal: string;
  positions_value: string;
  open_pnl: string;
  open_pnl_bps: number;
  /** realised P&L of agreements settled in the last 30 days + open P&L */
  month_pnl: string;
  month_change_bps: number;
  positions?: PositionBriefOut[];
  followed?: FollowedTraderOut[];
  followed_count?: number;
  invested_count?: number;
  listing_interactions: ListingInteractionsOut;
}

/** Figma 1f: sermaye bütçesi, risk profili, piyasalar. */
export interface CustomerProfileIn {
  budget_amount: number | string;
  risk_profile: RiskProfile;
  markets: MarketCategory[];
}

export interface DepositInfoAssetOut {
  code: string;
  display_code: string;
  issuer?: string | null;
  needs_trustline: boolean;
  /** null when the account does not exist yet */
  has_trustline?: boolean | null;
  deposit_enabled?: boolean;
  deposit_min?: string | null;
  deposit_max?: string | null;
}

export interface DepositInfoOut {
  address: string;
  network: string;
  network_passphrase: string;
  funded?: boolean | null;
  /** testnet only: GET this to fund the account */
  friendbot_url?: string | null;
  /** SEP-7 `web+stellar:pay?destination=...` for QR codes */
  pay_uri: string;
  instructions: string[];
  anchor_enabled: boolean;
  anchor_home_domain: string;
  anchor_assets?: DepositInfoAssetOut[];
  anchor_error?: string | null;
}

export interface DiscoverActionIn {
  action: InteractionAction;
}

export interface DiscoverActionOut {
  target_type: InteractionTargetType;
  target_id: string;
  action: InteractionAction;
  /** False when the same action was already recorded (idempotent) */
  created: boolean;
  remaining: number;
  following?: boolean | null;
  saved?: boolean | null;
  like_count?: number | null;
}

/** One swipe card. A customer sees service listings rendered as trader cards (owner + stats), a trad… */
export interface DiscoverCardOut {
  target_type?: InteractionTargetType;
  target_id: string;
  owner_target_id: string;
  kind: ListingKind;
  listing: ListingOut;
  is_following?: boolean;
  is_saved?: boolean;
  /** machine keys the client localises */
  tags?: string[];
}

export interface DiscoverFeedOut {
  items: DiscoverCardOut[];
  next_cursor?: string | null;
  /** cards the viewer has not acted on yet (incl. this page) */
  remaining: number;
  kind: ListingKind;
}

export interface DiscoverRemainingOut {
  remaining: number;
  kind: ListingKind;
}

export interface FollowOut {
  trader_id: string;
  following: boolean;
  follower_count: number;
}

export interface FollowedTraderOut {
  trader_id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  risk_level?: RiskLevel | null;
  commission_bps?: number | null;
  total_return_bps?: number;
  monthly_return_bps?: number;
  rating_avg?: string;
  /** the customer has an open agreement with this trader */
  invested: boolean;
  invested_principal?: string;
  open_pnl_bps?: number | null;
}

export interface FxConvertOut {
  amount_usd: string;
  amount_try: string;
  rate: string;
  stale: boolean;
}

export interface FxOut {
  pair?: string;
  base?: string;
  quote?: string;
  rate: string;
  source: string;
  fetched_at: string;
  stale?: boolean;
  cache_seconds: number;
  /** indicative USD price per asset code (null = unknown) */
  usd_prices?: Record<string, string | null>;
  usd_prices_indicative?: boolean;
  note: string;
}

export type InteractionAction = "pass" | "like" | "save" | "follow" | "view" | "offer_request";

export type InteractionTargetType = "listing" | "user";

export interface InteractiveIn {
  /** `native`/`XLM` or an issued code */
  asset_code: string;
  asset_issuer?: string | null;
  amount?: number | string | null;
  lang?: string | null;
  /** `postMessage` appends callback=postMessage to the interactive url */
  callback?: "postMessage" | null;
  /** deposit: the wallet can claim claimable balances (only useful when /info allows) */
  claimable_balance_supported?: boolean;
  /** deposit: start even when the account has no trustline (anchor -> pending_trust) */
  skip_trustline_check?: boolean;
}

export interface InteractiveOut {
  id: string;
  anchor_tx_id: string;
  kind: AnchorTxKind;
  status: string;
  type?: string;
  /** open in a system webview / popup, never an iframe */
  interactive_url: string;
  asset_code: string;
  asset_issuer?: string | null;
  amount?: string | null;
  action: "open_interactive" | "send_payment" | "add_trustline" | "wait" | "none" | "retry";
  action_label: string;
}

export interface KycIn {
  /** SEP-9 fields (first_name, last_name, email_address, ...) */
  fields: Record<string, string>;
  /** anchor customer type when required */
  type?: string | null;
  /** existing SEP-12 customer id */
  customer_id?: string | null;
}

export interface KycOut {
  customer_id?: string | null;
  status?: string | null;
  fields?: Record<string, unknown> | null;
  provided_fields?: Record<string, unknown> | null;
  message?: string | null;
}

/** Enough of a listing to render an offer row (Figma 6c/6d). */
export interface ListingBriefOut {
  id: string;
  owner_id: string;
  kind: ListingKind;
  title: string;
  status: ListingStatus;
  risk_profile?: RiskProfile | null;
  markets?: string[];
  amount?: string | null;
  duration_days?: number | null;
  max_loss_bps?: number | null;
  commission_bps?: number | null;
  min_capital?: string | null;
}

export interface ListingCountsOut {
  active?: number;
  paused?: number;
  closed?: number;
}

/** `kind` is optional: a customer always creates a capital listing, a trader a service listing. Capi… */
export interface ListingCreateIn {
  kind?: ListingKind | null;
  title: string;
  description?: string;
  markets?: MarketCategory[] | null;
  risk_profile?: RiskProfile | null;
  amount?: number | string | null;
  base_asset_id?: string | null;
  duration_days?: number | null;
  max_loss_bps?: number | null;
  commission_bps?: number | null;
  min_capital?: number | string | null;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
}

/** GET /listings/{id}: the owner additionally sees the offers on the listing and a viewer sees wheth… */
export interface ListingDetailOut {
  id: string;
  owner_id: string;
  owner: UserOut;
  kind: ListingKind;
  title: string;
  description?: string;
  risk_profile?: RiskProfile | null;
  markets?: string[];
  status: ListingStatus;
  amount?: string | null;
  base_asset_id?: string | null;
  base_asset?: AssetOut | null;
  duration_days?: number | null;
  max_loss_bps?: number | null;
  commission_bps?: number | null;
  min_capital?: string | null;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
  view_count?: number;
  like_count?: number;
  offer_count?: number;
  closed_at?: string | null;
  created_at: string;
  updated_at?: string | null;
  is_owner?: boolean | null;
  is_saved?: boolean | null;
  is_liked?: boolean | null;
  offers?: OfferOut[] | null;
  pending_offers?: number;
  my_offer_id?: string | null;
}

/** "İlanıma Gelen Etkileşimler": counters summed over the user's listings. */
export interface ListingInteractionsOut {
  listings?: number;
  views?: number;
  likes?: number;
  offers?: number;
  pending_offers?: number;
}

export type ListingKind = "capital" | "service";

export interface ListingOut {
  id: string;
  owner_id: string;
  owner: UserOut;
  kind: ListingKind;
  title: string;
  description?: string;
  risk_profile?: RiskProfile | null;
  markets?: string[];
  status: ListingStatus;
  amount?: string | null;
  base_asset_id?: string | null;
  base_asset?: AssetOut | null;
  duration_days?: number | null;
  max_loss_bps?: number | null;
  commission_bps?: number | null;
  min_capital?: string | null;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
  view_count?: number;
  like_count?: number;
  offer_count?: number;
  closed_at?: string | null;
  created_at: string;
  updated_at?: string | null;
  is_owner?: boolean | null;
  is_saved?: boolean | null;
  is_liked?: boolean | null;
}

export type ListingStatus = "active" | "paused" | "closed";

/** PATCH body: only the fields present are applied. `kind` and `owner` never change. */
export interface ListingUpdateIn {
  title?: string | null;
  description?: string | null;
  markets?: MarketCategory[] | null;
  risk_profile?: RiskProfile | null;
  amount?: number | string | null;
  base_asset_id?: string | null;
  duration_days?: number | null;
  max_loss_bps?: number | null;
  commission_bps?: number | null;
  min_capital?: number | string | null;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
}

export interface LoginOut {
  token: string;
  expires_at: string;
  public_key: string;
  registered: boolean;
  user?: MeOut | null;
}

export interface MarkReadIn {
  ids?: string[];
  all?: boolean;
  /** with all=true: only this tab */
  category?: NotificationCategory | null;
}

export interface MarkReadOut {
  updated: number;
}

/** "Piyasalar" chips map to token categories (DESIGN §0). */
export type MarketCategory = "crypto" | "stable_fx" | "defi";

/** The caller's own profile. */
export interface MeOut {
  id: string;
  stellar_address: string;
  role: UserRole;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
  markets?: string[];
  created_at: string;
  budget_amount?: string | null;
  risk_profile?: RiskProfile | null;
  strategy_summary?: string | null;
  commission_bps?: number | null;
  min_capital?: string | null;
  risk_level?: RiskLevel | null;
  stats?: TraderStats | null;
  expo_push_token?: string | null;
  is_admin?: boolean;
  is_active?: boolean;
  last_login_at?: string | null;
  updated_at?: string | null;
}

export interface MessageCreateIn {
  body: string;
}

export interface MessageOut {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at?: string | null;
  is_mine?: boolean | null;
}

export interface MessagesPageOut {
  conversation_id: string;
  /** chronological (oldest first) */
  items: MessageOut[];
  has_more?: boolean;
}

export interface MissingTrustlineOut {
  asset_code: string;
  issuer: string;
  asset_id?: string | null;
  /** anchor_deposit | account_not_funded */
  reason: string;
  build_endpoint?: string;
}

export interface MovementOut {
  id: string;
  kind: "payment_in" | "payment_out" | "create_account" | "agreement_escrow" | "agreement_payout" | "agreement_refund" | "anchor_deposit" | "anchor_withdraw";
  direction: "in" | "out" | "none";
  title: string;
  asset_code: string;
  asset_issuer?: string | null;
  amount?: string | null;
  value_try?: string | null;
  counterparty?: string | null;
  memo?: string | null;
  tx_hash?: string | null;
  status?: string | null;
  at: string;
  ref_type: "payment" | "agreement" | "anchor";
  ref_id?: string | null;
}

export interface NonceIn {
  public_key: string;
}

export interface NonceOut {
  nonce: string;
  message: string;
  expires_at: string;
}

export type NotificationCategory = "listing" | "offer" | "agreement" | "wallet" | "system";

export interface NotificationOut {
  id: string;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read_at?: string | null;
  created_at: string;
}

export interface OfferAcceptOut {
  offer: OfferOut;
  agreement: AgreementDraftOut;
  conversation_id: string;
  /** on-chain creation the acceptor performs next: customer -> `open` (escrows the principal), trader … */
  next_action: "open" | "propose";
}

/** Terms the sender proposes. Fields left out fall back to the listing / the sender's profile: * tra… */
export interface OfferCreateIn {
  listing_id: string;
  amount?: number | string | null;
  base_asset_id?: string | null;
  duration_days?: number | null;
  commission_bps?: number | null;
  max_drawdown_bps?: number | null;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
  note?: string | null;
  /** offer validity window */
  expires_in_hours?: number;
}

export type OfferDirection = "trader_to_customer" | "customer_to_trader";

export interface OfferOut {
  id: string;
  listing_id: string;
  listing: ListingBriefOut;
  from_user_id: string;
  to_user_id: string;
  from_user: UserOut;
  to_user: UserOut;
  direction: OfferDirection;
  amount: string;
  base_asset_id: string;
  base_asset: AssetOut;
  duration_days: number;
  commission_bps: number;
  max_drawdown_bps: number;
  expected_return_min_bps?: number | null;
  expected_return_max_bps?: number | null;
  note?: string | null;
  status: OfferStatus;
  expires_at: string;
  responded_at?: string | null;
  agreement_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  conversation_id?: string | null;
  is_incoming?: boolean | null;
}

export interface OfferRejectIn {
  reason?: string | null;
}

export interface OfferStatsOut {
  pending_inbox: number;
  pending_outbox: number;
}

export type OfferStatus = "pending" | "accepted" | "rejected" | "withdrawn" | "expired";

export interface PartyOut {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  stellar_address: string;
  role: UserRole;
}

export interface PendingOfferBriefOut {
  offer_id: string;
  listing_id: string;
  from_user_id: string;
  from_username: string;
  from_display_name: string;
  from_avatar_url?: string | null;
  amount: string;
  base_asset_code: string;
  duration_days: number;
  commission_bps: number;
  markets?: string[];
  risk_profile?: RiskProfile | null;
  expires_at: string;
  created_at: string;
}

export interface PendingTxBriefOut {
  id: string;
  kind: PendingTxKind;
  status: PendingTxStatus;
  tx_hash?: string | null;
  created_at: string;
  expires_at: string;
}

export type PendingTxKind = "open" | "propose" | "fund" | "accept" | "cancel" | "trade" | "settle" | "payment" | "trustline" | "admin";

export interface PendingTxOut {
  id: string;
  user_id: string;
  kind: PendingTxKind;
  agreement_id?: string | null;
  status: PendingTxStatus;
  tx_hash?: string | null;
  unsigned_xdr: string;
  result?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
  created_at: string;
  submitted_at?: string | null;
  expires_at: string;
  is_expired: boolean;
}

export type PendingTxStatus = "built" | "submitted" | "success" | "failed" | "expired";

export interface PerformancePoint {
  at: string;
  value: string;
  principal: string;
  return_bps: number;
}

export interface PositionBalanceOut {
  asset_id: string;
  code: string;
  contract_id: string;
  balance: string;
}

export interface PositionBriefOut {
  agreement_id: string;
  onchain_id?: number | null;
  status: AgreementStatus;
  counterparty_id: string;
  counterparty_username: string;
  counterparty_display_name: string;
  counterparty_avatar_url?: string | null;
  base_asset_code: string;
  principal: string;
  current_value: string;
  pnl: string;
  pnl_bps: number;
  commission_bps: number;
  duration_days: number;
  start_time?: string | null;
  end_time?: string | null;
}

export interface PositionOut {
  agreement_id: string;
  onchain_id?: number | null;
  customer_id: string;
  customer_username: string;
  customer_display_name: string;
  base_asset_code: string;
  principal: string;
  current_value?: string | null;
  pnl_bps?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  balances?: PositionBalanceOut[];
}

/** "Profilini Güçlendir" (Figma 5c). */
export interface ProfileChecklistOut {
  wallet_connected?: boolean;
  has_avatar?: boolean;
  has_strategy?: boolean;
  has_service_listing?: boolean;
  has_trade?: boolean;
  completion_pct?: number;
}

export interface PushTokenIn {
  /** null unregisters the device */
  expo_push_token?: string | null;
}

/** Router quote through the vault's allow-listed router (Soroswap) plus the drawdown headroom the co… */
export interface QuoteOut {
  agreement_id: string;
  onchain_id: number;
  token_in: AssetBriefOut;
  token_out: AssetBriefOut;
  amount_in: string;
  /** router `router_get_amounts_out` result */
  amount_out: string;
  /** amount_out × (1 − slippage_bps) — what the trade tx will carry */
  min_out: string;
  slippage_bps: number;
  /** token_out per 1 token_in */
  price: string;
  /** router (on-chain simulation) | fake */
  source: string;
  /** Soroswap API quote when an API key is set */
  api_amount_out?: string | null;
  price_impact_pct?: string | null;
  /** agreement's current balance of token_in */
  balance_in: string;
  /** `value_in_base` now */
  value_before: string;
  /** value_before − in-leg + out-leg (both valued in base) */
  value_after_estimate: string;
  principal: string;
  max_drawdown_bps: number;
  drawdown_floor: string;
  /** value_after_estimate − drawdown_floor (negative = would be rejected) */
  headroom: string;
  headroom_bps: number;
  allowed: boolean;
  /** why the trade would be rejected (null when allowed) */
  reason?: string | null;
  deadline_seconds: number;
  quoted_at: string;
}

export interface RatingCreateIn {
  score: number;
  comment?: string | null;
}

export interface RatingCreatedOut {
  rating: RatingOut;
  trader_id: string;
  rating_avg?: string;
  rating_count?: number;
}

export interface RatingOut {
  id: string;
  agreement_id: string;
  customer_id: string;
  customer_username?: string | null;
  customer_display_name?: string | null;
  score: number;
  comment?: string | null;
  created_at: string;
}

export interface RatingsSummary {
  avg: string;
  count: number;
  distribution?: Record<string, number>;
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

export interface RegisterOut {
  user: MeOut;
  token: string;
  expires_at: string;
}

/** Trader risk level (Figma 1g "risk seviyesi"). */
export type RiskLevel = "low" | "medium" | "high";

/** Customer / listing risk profile (Figma 1f "risk profili"). */
export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface Sep10ChallengeOut {
  transaction: string;
  network_passphrase: string;
}

export interface Sep10VerifyIn {
  /** Challenge transaction XDR signed by the client */
  transaction: string;
}

/** TL equivalents (DESIGN §0 Money): base-asset amounts × USD price × USD/TRY. */
export interface TlOut {
  /** TRY per 1 USD */
  rate: string;
  rate_source: string;
  stale?: boolean;
  /** USD per 1 base asset (null = unknown) */
  base_usd_price?: string | null;
  base_price_source?: string | null;
  principal_try?: string | null;
  current_value_try?: string | null;
  pnl_try?: string | null;
  final_value_try?: string | null;
  customer_payout_try?: string | null;
}

export interface TokenIn {
  /** user-signed challenge XDR */
  signed_xdr: string;
}

export interface TradeBriefOut {
  id: string;
  agreement_id: string;
  tx_hash?: string | null;
  ledger?: number | null;
  symbol_label: string;
  token_in_code: string;
  token_out_code: string;
  amount_in: string;
  amount_out: string;
  value_after?: string | null;
  note?: string | null;
  created_at: string;
}

export interface TradeNoteIn {
  note?: string | null;
  notify_investors?: boolean | null;
}

export interface TradeOut {
  id: string;
  agreement_id: string;
  onchain_id?: number | null;
  onchain_seq?: number | null;
  tx_hash?: string | null;
  ledger?: number | null;
  trader_id?: string | null;
  token_in: AssetBriefOut;
  token_out: AssetBriefOut;
  amount_in: string;
  amount_out: string;
  /** amount_out / amount_in */
  price?: string | null;
  value_after?: string | null;
  note?: string | null;
  symbol_label?: string | null;
  notify_investors?: boolean;
  created_at: string;
}

export interface TradeTxIn {
  /** asset id, C... contract id or asset code */
  token_in: string;
  /** asset id, C... contract id or asset code */
  token_out: string;
  amount_in: number | string;
  /** default settings.default_trade_slippage_bps */
  slippage_bps?: number | null;
  note?: string | null;
  notify_investors?: boolean;
  deadline_seconds?: number;
}

export interface TraderCardOut {
  user: UserOut;
  follower_count: number;
  is_following?: boolean | null;
}

export interface TraderDashboardOut {
  role?: "trader";
  generated_at: string;
  base_asset_code: string;
  /** current value of open agreements (principal until valued) */
  managed_capital: string;
  invested_principal: string;
  open_pnl: string;
  open_pnl_bps: number;
  active_investors: number;
  pending_offers_count: number;
  /** trader_fee of agreements settled in the last 30 days */
  month_commission: string;
  total_commission: string;
  settled_agreements: number;
  positions?: PositionBriefOut[];
  pending_offers?: PendingOfferBriefOut[];
  listing_interactions: ListingInteractionsOut;
  profile_checklist: ProfileChecklistOut;
}

/** Figma 1g: piyasalar, strateji özeti, komisyon, min sermaye, risk seviyesi. */
export interface TraderProfileIn {
  markets: MarketCategory[];
  strategy_summary: string;
  /** trader share of profit, bps */
  commission_bps: number;
  min_capital: number | string;
  risk_level: RiskLevel;
}

export interface TraderProfileOut {
  user: UserOut;
  stats: TraderStats;
  follower_count: number;
  is_following?: boolean | null;
  active_listings: number;
  performance_range: string;
  performance: PerformancePoint[];
  positions: PositionOut[];
  recent_trades: TradeBriefOut[];
  ratings: RatingsSummary;
  recent_ratings: RatingOut[];
}

/** Stats columns maintained by the indexer/reconciler (bps = basis points). */
export interface TraderStats {
  total_return_bps?: number;
  monthly_return_bps?: number;
  max_drawdown_bps?: number;
  win_rate_bps?: number;
  managed_capital?: string;
  active_agreements?: number;
  rating_avg?: string;
  rating_count?: number;
}

export interface TrustlineIn {
  asset_id?: string | null;
  asset_code?: string | null;
  issuer?: string | null;
  /** omit for the maximum trustline limit */
  limit?: number | string | null;
}

/** Optional body of `POST /agreements/{id}/tx/{action}`. */
export interface TxActionIn {
  /** settle only: each min_out = router quote × (1 − bps); default settings.settle_slippage_bps */
  slippage_bps?: number | null;
}

export interface TxSubmitIn {
  pending_tx_id: string;
  signed_xdr: string;
}

export interface TxSubmitOut {
  pending_tx_id: string;
  kind: PendingTxKind;
  tx_hash: string;
  /** SUCCESS | FAILED | PENDING (not yet in a ledger after the poll window) */
  status: "SUCCESS" | "FAILED" | "PENDING";
  pending_status: PendingTxStatus;
  ledger?: number | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  contract_error?: string | null;
  contract_error_code?: number | null;
  agreement_id?: string | null;
  agreement_status?: AgreementStatus | null;
  onchain_id?: number | null;
  trade_id?: string | null;
  /** decoded vault events of the transaction */
  events?: Record<string, unknown>[];
}

export interface UnreadCountOut {
  unread: number;
  by_category?: Record<string, number>;
}

/** What the mobile app signs. `summary` explains the transaction ("what am I signing?"). */
export interface UnsignedTxOut {
  pending_tx_id: string;
  kind: PendingTxKind;
  agreement_id?: string | null;
  unsigned_xdr: string;
  network_passphrase: string;
  /** hash of the envelope; signing does not change it */
  tx_hash: string;
  /** G... account that must sign (the caller) */
  source: string;
  expires_at: string;
  summary: Record<string, unknown>;
}

/** Public profile. Never exposes the Expo push token or admin flag. */
export interface UserOut {
  id: string;
  stellar_address: string;
  role: UserRole;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
  markets?: string[];
  created_at: string;
  budget_amount?: string | null;
  risk_profile?: RiskProfile | null;
  strategy_summary?: string | null;
  commission_bps?: number | null;
  min_capital?: string | null;
  risk_level?: RiskLevel | null;
  stats?: TraderStats | null;
}

export type UserRole = "customer" | "trader";

/** PATCH body: only fields present in the request are applied (null clears a nullable field). Role-s… */
export interface UserUpdateIn {
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  expo_push_token?: string | null;
  markets?: MarketCategory[] | null;
  budget_amount?: number | string | null;
  risk_profile?: RiskProfile | null;
  strategy_summary?: string | null;
  commission_bps?: number | null;
  min_capital?: number | string | null;
  risk_level?: RiskLevel | null;
}

export interface ValueHistoryOut {
  agreement_id: string;
  range: "24h" | "7d" | "30d" | "90d" | "all";
  principal: string;
  current_value?: string | null;
  high_water_value?: string | null;
  points: ValuePointOut[];
}

export interface ValuePointOut {
  at: string;
  value: string;
  return_bps: number;
}

export interface VerifyIn {
  public_key: string;
  nonce: string;
  /** base64 ed25519 signature over the message */
  signature: string;
}

export interface WalletBalanceOut {
  /** allow-listed asset row; null for other trustlines */
  asset?: AssetBriefOut | null;
  code: string;
  issuer?: string | null;
  contract_id?: string | null;
  balance: string;
  /** balance minus selling liabilities (classic) / balance (Soroban) */
  available: string;
  limit?: string | null;
  /** TL equivalent when a USD price is known */
  value_try?: string | null;
  source: "horizon" | "soroban";
  is_anchor_asset?: boolean;
  is_base_allowed?: boolean;
}

export interface WalletFxOut {
  /** TRY per 1 USD */
  rate: string;
  source: string;
  stale?: boolean;
}

export interface WalletOut {
  address: string;
  network: string;
  /** false until the account exists on the ledger (friendbot on testnet) */
  funded: boolean;
  balances: WalletBalanceOut[];
  total_try?: string | null;
  fx?: WalletFxOut | null;
  missing_trustlines?: MissingTrustlineOut[];
  movements?: MovementOut[];
  anchor_enabled: boolean;
  anchor_home_domain: string;
  friendbot_url?: string | null;
  updated_at: string;
}

export interface WalletPaymentIn {
  /** destination G... (or M...) account */
  to: string;
  asset_id?: string | null;
  asset_code?: string | null;
  asset_issuer?: string | null;
  amount: number | string;
  memo?: string | null;
  memo_type?: "text" | "id" | "hash";
}
