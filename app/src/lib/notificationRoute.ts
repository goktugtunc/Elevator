import type { Href } from 'expo-router';

import type { UserRole } from '@/lib/api/types';

/**
 * Bir bildirimin hedef ekranı — hem Bildirimler listesi hem de push'a dokunma
 * bunu kullanır, böylece iki yol asla ayrışmaz.
 *
 * Önce `data` içindeki kimliklere bakılır (en kesin hedef), yoksa `category`
 * yedeğe düşer. Sunucu bazı olaylarda yönlendirilebilir bir kimlik taşımıyor
 * (teklif geri çekildi → yalnız `offer_id`, yeni takipçi → `follower_id`,
 * anchor durumu → `anchor_transaction_id`); yedek olmadan o bildirimlere
 * dokunmak hiçbir şey yapmıyordu.
 *
 * Push yükü düz gelir: `{ notification_id, category, type, ...data }`.
 */
export function notificationRoute(
  data: Record<string, unknown> | undefined,
  category: string | undefined,
  role: UserRole | null,
): Href | null {
  const d = data ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  const agreementId = str(d.agreement_id);
  if (agreementId) return `/contract/${agreementId}` as Href;
  const conversationId = str(d.conversation_id);
  if (conversationId) return `/messages/${conversationId}` as Href;
  const listingId = str(d.listing_id);
  if (listingId) return `/listing/${listingId}` as Href;
  const traderId = str(d.trader_id);
  if (traderId) return `/trader/${traderId}` as Href;

  switch (category) {
    case 'wallet':
      return '/wallet' as Href;
    case 'offer':
    case 'listing':
      return role === 'trader' ? ('/(trader)/listings' as Href) : ('/(customer)/listings' as Href);
    case 'agreement':
      return role === 'trader' ? ('/(trader)/dashboard' as Href) : ('/(customer)/dashboard' as Href);
    default:
      return null;
  }
}
