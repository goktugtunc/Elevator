/**
 * Alan modeli — Figma ekranlarındaki kavramların TypeScript karşılığı.
 * Backend OpenAPI şeması yayınlandığında bu tipler o şemayla hizalanacak.
 */

export type Role = 'customer' | 'trader';

/** Figma "Risk Badge" — level=low | mid | high */
export type RiskLevel = 'low' | 'mid' | 'high';

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Muhafazakâr',
  mid: 'Dengeli',
  high: 'Agresif',
};

export const RISK_LEVELS: RiskLevel[] = ['low', 'mid', 'high'];

/** Figma "Status Chip" — status=Teklif | Onay Bekliyor | Aktif | Tamamlandı | İptal */
export type ContractStatus = 'offer' | 'pending' | 'active' | 'completed' | 'cancelled';

export const STATUS_LABEL: Record<ContractStatus, string> = {
  offer: 'Teklif',
  pending: 'Onay Bekliyor',
  active: 'Aktif',
  completed: 'Tamamlandı',
  cancelled: 'İptal',
};

export type Market = 'BIST Hisse' | 'Kripto' | 'Forex' | 'Vadeli' | 'Emtia';

/** Figma'daki piyasa chip'lerinin sırası (Kayıt, İlan Oluştur, Keşfet filtreleri). */
export const MARKETS: Market[] = ['BIST Hisse', 'Kripto', 'Forex', 'Vadeli', 'Emtia'];

export interface UserProfile {
  address: string; // Stellar public key (G...)
  role: Role;
  username: string;
  avatarInitials: string;
  createdAt: string;
}

export interface CustomerProfile extends UserProfile {
  role: 'customer';
  budgetTRY: number;
  riskPreference: RiskLevel;
  markets: Market[];
}

export interface TraderProfile extends UserProfile {
  role: 'trader';
  handle: string; // @kaandemir
  markets: Market[];
  strategySummary: string;
  commissionPct: number; // 20 → %20
  minCapitalTRY: number;
  rating: number; // 4.9
  ratingCount: number; // 212
  return12mPct: number; // +86.4
  maxDrawdownPct: number; // -11.2
  activeInvestors: number;
  sparkline: number[];
  tags: string[]; // "Düşük Drawdown", "12 Ay+", "Hızlı Yanıt"
}

/**
 * İlan sahibinin kart üzerinde gösterilen özeti.
 * BE-03: `/listings` yanıtında gömülü gelmeli — aksi hâlde Keşfet kartı
 * yalnızca cüzdan adresini gösterebilir (ek istek atmamak için).
 */
export interface ListingOwner {
  address: string;
  username: string;
  avatarInitials: string;
  role: Role;
  handle?: string; // @kaandemir
  rating?: number;
  ratingCount?: number;
  return12mPct?: number;
  maxDrawdownPct?: number;
  activeInvestors?: number;
  sparkline?: number[];
  tags?: string[];
}

/** Müşterinin "Sermaye İlanı" ya da trader'ın "Hizmet İlanı". */
export interface Listing {
  id: string;
  ownerAddress: string;
  owner?: ListingOwner;
  kind: 'capital' | 'service';
  title: string;
  market: Market;
  riskLevel: RiskLevel;
  durationMonths: number;
  capitalTRY?: number; // capital ilanı
  minCapitalTRY?: number; // service ilanı
  commissionPct?: number; // service ilanı
  expectedCommissionRange?: [number, number]; // capital ilanı
  maxLossPct?: number;
  description: string;
  status: 'active' | 'pending' | 'closed';
  stats: { views: number; interest: number; offers: number };
  createdAt: string;
}

export interface Offer {
  id: string;
  listingId: string;
  fromAddress: string;
  commissionPct: number;
  expectedReturnRange: [number, number];
  note?: string;
  status: ContractStatus;
  createdAt: string;
}

/** Zincir üstü escrow sözleşmesinin arayüz görünümü (Figma 9d Sözleşme). */
export interface RentalContract {
  id: string;
  onChainId?: string;
  customerAddress: string;
  traderAddress: string;
  capitalTRY: number;
  durationMonths: number;
  commissionPct: number;
  riskLevel: RiskLevel;
  maxDrawdownPct: number;
  status: ContractStatus;
  pnlPct?: number;
  startedAt?: string;
  endsAt?: string;
}

export type TradeSide = 'buy' | 'sell';

/** Trader'ın açtığı/kapattığı işlem (Figma 5a İşlemler, 3b Hareketler). */
export interface Trade {
  id: string;
  traderAddress: string;
  symbol: string; // THYAO, EUR/USD
  side: TradeSide;
  quantity: number;
  unit: 'adet' | 'lot' | 'kontrat';
  entryPrice: number;
  currentPrice?: number;
  pnlPct?: number;
  note?: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt?: string;
  notifyInvestors: boolean;
}

export type NotificationKind =
  | 'offer_received'
  | 'trade_opened'
  | 'listing_interest'
  | 'risk_alert'
  | 'deposit_completed'
  | 'contract_activated'
  | 'request_received'
  | 'offer_accepted'
  | 'commission_received';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  subtitle: string;
  createdAt: string;
  read: boolean;
}

export interface Message {
  id: string;
  threadId: string;
  fromAddress: string;
  text: string;
  createdAt: string;
}

export interface MessageThread {
  id: string;
  peer: Pick<UserProfile, 'address' | 'username' | 'avatarInitials' | 'role'>;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
}

/** Cüzdan hareketi (Figma 8c Cüzdan). Anchor SEP-24 işlemleri de buraya düşer. */
export interface WalletTransaction {
  id: string;
  kind: 'deposit' | 'withdraw' | 'commission' | 'escrow_lock' | 'escrow_release';
  amountTRY: number;
  counterparty?: string;
  createdAt: string;
  status: 'pending' | 'completed' | 'failed';
  txHash?: string;
}
