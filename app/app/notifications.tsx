import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { Button, Card, Chip, ListRow, Text } from '@/components/ui';
import { notificationsApi } from '@/lib/api';
import type { NotificationCategory, NotificationOut, UserRole } from '@/lib/api/types';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

const CATEGORIES: { value: NotificationCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'offer', label: 'Offers' },
  { value: 'agreement', label: 'Agreements' },
  { value: 'listing', label: 'Listings' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'system', label: 'System' },
];

/**
 * Figma 10a–10c · Bildirimler (node 27:96 · 27:240 · 27:371).
 * Kategori süzgeci, tümünü okundu işaretleme ve bildirimden ilgili ekrana gitme.
 */
export default function Notifications() {
  const router = useRouter();
  const qc = useQueryClient();
  const role = useSession((s) => s.role);
  const [category, setCategory] = useState<NotificationCategory | 'all'>('all');

  const list = useQuery({
    queryKey: ['notifications', category],
    queryFn: () =>
      notificationsApi.list({
        limit: 50,
        category: category === 'all' ? undefined : category,
      }),
  });

  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: notificationsApi.unreadCount,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markAll = useMutation({ mutationFn: () => notificationsApi.markAllRead(), onSuccess: refresh });
  const markOne = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: refresh,
  });

  const unreadCount = unread.data?.unread ?? 0;

  const groups = useMemo(() => groupByDay(list.data?.items ?? []), [list.data]);

  const open = (n: NotificationOut) => {
    if (!n.read_at) markOne.mutate(n.id);
    const target = routeFor(n, role);
    if (target) router.push(target);
  };

  return (
    <Screen padded={false}>
      <TopBar
        title="Notifications"
        right={
          unreadCount > 0 ? (
            <Button
              title="Mark all read"
              variant="ghost"
              size="sm"
              loading={markAll.isPending}
              onPress={() => markAll.mutate()}
            />
          ) : null
        }
      />
      <View style={styles.body}>
        <View style={styles.chips}>
          {CATEGORIES.map((c) => (
            <Chip
              key={c.value}
              label={c.label}
              active={category === c.value}
              onPress={() => setCategory(c.value)}
            />
          ))}
        </View>

        <AsyncBoundary
          query={list}
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              title="You are all caught up"
              body="Offers, agreement updates and wallet events land here."
            />
          }
        >
          {() => (
            <>
              {groups.map(([day, items]) => (
                <View key={day} style={styles.group}>
                  <Text variant="overline" color="text3">
                    {day}
                  </Text>
                  <Card style={styles.list}>
                    {items.map((n) => (
                      <View key={n.id} style={[styles.row, !n.read_at && styles.rowUnread]}>
                        <ListRow
                          title={n.title}
                          subtitle={n.body}
                          meta={formatRelative(n.created_at)}
                          chevron={Boolean(routeFor(n, role))}
                          onPress={() => open(n)}
                        />
                      </View>
                    ))}
                  </Card>
                </View>
              ))}
            </>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

/**
 * Bildirimin hedef ekranı.
 *
 * Önce `data` içindeki kimliklere bakılır (en kesin hedef), yoksa `category`
 * yedeğe düşer. Yalnızca kimliklere bakmak yetmiyordu: sunucu bazı olaylarda
 * yönlendirilebilir bir kimlik taşımıyor (teklif geri çekildi → yalnız
 * `offer_id`, yeni takipçi → `follower_id`, anchor durumu →
 * `anchor_transaction_id`) ve o bildirimlere dokunmak hiçbir şey yapmıyordu.
 */
function routeFor(n: NotificationOut, role: UserRole | null): Href | null {
  const data = n.data ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

  const agreementId = str(data.agreement_id);
  if (agreementId) return `/contract/${agreementId}` as Href;
  const conversationId = str(data.conversation_id);
  if (conversationId) return `/messages/${conversationId}` as Href;
  const listingId = str(data.listing_id);
  if (listingId) return `/listing/${listingId}` as Href;
  const traderId = str(data.trader_id);
  if (traderId) return `/trader/${traderId}` as Href;

  // Kimlik yok: kategoriye göre en yakın ekran. İlanlarım rol'e göre ayrışıyor.
  switch (n.category) {
    case 'wallet':
      return '/wallet' as Href;
    case 'offer':
    case 'listing':
      return role === 'trader' ? ('/(trader)/listings' as Href) : ('/(customer)/listings' as Href);
    default:
      return null;
  }
}

/** Figma'daki "Bugün / Dün / tarih" grupları. */
function groupByDay(items: NotificationOut[]): [string, NotificationOut[]][] {
  const today = new Date();
  const label = (iso: string) => {
    const d = new Date(iso);
    const days = Math.floor(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
        Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) /
        86_400_000,
    );
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString();
  };
  const map = new Map<string, NotificationOut[]>();
  for (const n of items) {
    const key = label(n.created_at);
    const bucket = map.get(key);
    if (bucket) bucket.push(n);
    else map.set(key, [n]);
  }
  return [...map.entries()];
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  group: { gap: spacing.xs },
  list: { paddingVertical: 0 },
  row: { borderRadius: radius.sm },
  rowUnread: { backgroundColor: colors.navy050, paddingHorizontal: spacing.sm },
});
