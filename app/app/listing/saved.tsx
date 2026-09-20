import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { BookmarkX } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { Button, Card, ErrorNotice, Pill, RiskBadge, Text } from '@/components/ui';
import { discoverApi, listingsApi } from '@/lib/api';
import type { ListingOut } from '@/lib/api/types';
import { formatAmount, formatBps, formatDuration, formatRelative } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * Elevator'da kaydedilen ilanlar — `GET /listings/saved`.
 *
 * Kaydetmek ilanı akıştan düşürüyor (sunucuda `HIDING_ACTIONS`), yani kart bir
 * daha karşına çıkmıyor. Bu ekran olmadan kaydedilen ilan tamamen kayboluyordu:
 * "kaydet" düğmesi pratikte "gizle" işlevi görüyordu.
 */
export default function SavedListings() {
  const router = useRouter();
  const qc = useQueryClient();

  const saved = useQuery({
    queryKey: ['listings', 'saved'],
    queryFn: () => listingsApi.saved({ limit: 50 }),
  });

  const unsave = useMutation({
    mutationFn: (listingId: string) => discoverApi.unsaveListing(listingId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['listings', 'saved'] });
      // Kaydı kalkan ilan Elevator'a geri döner; sayaç da değişir.
      void qc.invalidateQueries({ queryKey: ['discover'] });
    },
  });

  return (
    <Screen padded={false}>
      <TopBar title="Saved listings" />
      <View style={styles.body}>
        {unsave.isError ? <ErrorNotice title="Could not remove it" error={unsave.error} /> : null}
        <AsyncBoundary
          query={saved}
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              title="Nothing saved yet"
              body="Save a listing in the Elevator to keep it here. Saved listings leave the swipe deck, so this is where you find them again."
              action={<Button title="Open the Elevator" size="sm" onPress={() => router.push('/discover')} />}
            />
          }
        >
          {(page) => (
            <View style={styles.list}>
              {page.items.map((l) => (
                <SavedRow
                  key={l.id}
                  listing={l}
                  busy={unsave.isPending && unsave.variables === l.id}
                  onOpen={() => router.push(`/listing/${l.id}`)}
                  onRemove={() => unsave.mutate(l.id)}
                />
              ))}
            </View>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function SavedRow({
  listing: l,
  busy,
  onOpen,
  onRemove,
}: {
  listing: ListingOut;
  busy: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const code = l.base_asset?.code ?? '';
  return (
    <Card style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.cardTitle}>
          <Text variant="h2" numberOfLines={1}>
            {l.title}
          </Text>
          <Text variant="caption" color="text3">
            @{l.owner.username} · {formatRelative(l.created_at)}
          </Text>
        </View>
        <RiskBadge level={l.risk_profile} />
      </View>

      <View style={styles.pills}>
        {(l.markets ?? []).map((m) => (
          <Pill key={m} label={m} />
        ))}
        {l.duration_days ? <Pill label={formatDuration(l.duration_days)} /> : null}
        {l.amount ? <Pill label={formatAmount(l.amount, code)} /> : null}
        {l.commission_bps != null ? <Pill label={formatBps(l.commission_bps)} /> : null}
      </View>

      <View style={styles.actions}>
        <Button title="Open" variant="secondary" size="sm" onPress={onOpen} />
        <View style={{ flex: 1 }} />
        <Button
          title="Remove"
          variant="ghost"
          size="sm"
          loading={busy}
          onPress={onRemove}
          leftIcon={<BookmarkX size={16} color={colors.text2} />}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  list: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardTitle: { flex: 1, gap: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
