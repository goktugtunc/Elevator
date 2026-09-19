import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { Button, Card, Chip, ListRow, Text } from '@/components/ui';
import { notificationsApi } from '@/lib/api';
import type { NotificationCategory, NotificationOut } from '@/lib/api/types';
import { formatRelative } from '@/lib/format';
import { notificationRoute } from '@/lib/notificationRoute';
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
    const target = notificationRoute(n.data, n.category, role);
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
                          chevron={Boolean(notificationRoute(n.data, n.category, role))}
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
