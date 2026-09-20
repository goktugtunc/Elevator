import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Bookmark, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AsyncBoundary,
  EmptyState,
  HeaderActions,
  Screen,
  ScreenHeader,
} from '@/components/layout';
import { Button, Card, Pill, RiskBadge, Segmented, Text } from '@/components/ui';
import { listingsApi } from '@/lib/api';
import type { ListingCountsOut, ListingOut, ListingStatus, UserRole } from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { formatAmount, formatBps, formatDuration, formatRelative } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * Sekmeler. "Draft" yalnızca taslak varken görünür: sermaye ilanı, parası
 * kasaya yatırılana kadar taslaktır; yatırma yarıda kalırsa ilan buradan
 * bulunup tamamlanabilsin ya da kapatılabilsin diye sekme açılır.
 */
const TABS: { value: keyof ListingCountsOut; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'closed', label: 'Closed' },
];

/**
 * Figma 6a/6b · İlanlarım (node 26:58 · 26:203) — `GET /listings/mine`.
 * İki rol aynı ekranı kullanır; müşteri sermaye, trader hizmet ilanı yayımlar.
 * Sekme sayıları `GET /listings/mine/counts`'ten gelir.
 */
export function MyListings({ role }: { role: UserRole }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ListingStatus>('active');

  const counts = useQuery({ queryKey: ['listings', 'mine', 'counts'], queryFn: listingsApi.mineCounts });
  const listings = useQuery({
    queryKey: ['listings', 'mine', status],
    queryFn: () => listingsApi.mine({ status, limit: 50 }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['listings', 'mine'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const setListingStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'pause' | 'resume' | 'close' }) =>
      next === 'pause'
        ? listingsApi.pause(id)
        : next === 'resume'
          ? listingsApi.resume(id)
          : listingsApi.close(id),
    onSuccess: refresh,
  });

  const kindLabel = role === 'trader' ? 'service listing' : 'capital listing';

  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader
        title="My Listings"
        right={
          <View style={styles.headerActions}>
            <HeaderActions />
            {/*
              Kaydedilenler ayrı bir ekranda: aşağıdaki sekmeler kendi ilanlarımın
              durumları, kaydedilenler ise başkalarının ilanları — aynı satıra
              konsa ikisi karışırdı.
            */}
            <Button
              title="Saved"
              variant="secondary"
              size="sm"
              onPress={() => router.push('/listing/saved')}
              leftIcon={<Bookmark size={16} color={colors.navy900} />}
            />
            <Button
              title="New"
              size="sm"
              onPress={() => router.push('/listing/create')}
              leftIcon={<Plus size={16} color={colors.onNavy} />}
            />
          </View>
        }
      />
      <View style={styles.body}>
        <Segmented
          options={TABS.filter((t) => t.value !== 'draft' || (counts.data?.draft ?? 0) > 0).map(
            (t) => ({
              value: t.value,
              label: counts.data?.[t.value] ? `${t.label} (${counts.data[t.value]})` : t.label,
            }),
          )}
          value={status}
          onChange={setStatus}
        />

        {setListingStatus.isError ? (
          <Text variant="caption" color="loss">
            {userMessage(setListingStatus.error)}
          </Text>
        ) : null}

        <AsyncBoundary
          query={listings}
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              title={`No ${status} listings`}
              body={
                status === 'active'
                  ? `Publish a ${kindLabel} so the other side can find you.`
                  : undefined
              }
              action={
                status === 'active' ? (
                  <Button
                    title="Create listing"
                    size="sm"
                    onPress={() => router.push('/listing/create')}
                  />
                ) : null
              }
            />
          }
        >
          {(page) => (
            <View style={styles.list}>
              {page.items.map((listing) => (
                <ListingRow
                  key={listing.id}
                  listing={listing}
                  busy={setListingStatus.isPending && setListingStatus.variables?.id === listing.id}
                  onOpen={() => router.push(`/listing/${listing.id}`)}
                  onStatus={(next) => setListingStatus.mutate({ id: listing.id, next })}
                />
              ))}
            </View>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function ListingRow({
  listing,
  busy,
  onOpen,
  onStatus,
}: {
  listing: ListingOut;
  busy: boolean;
  onOpen: () => void;
  onStatus: (next: 'pause' | 'resume' | 'close') => void;
}) {
  const isService = listing.kind === 'service';
  const assetCode = listing.base_asset?.code ?? '';
  return (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {listing.title}
          </Text>
          <Text variant="caption" color="text3">
            {isService ? 'Service listing' : 'Capital listing'} ·{' '}
            {formatRelative(listing.created_at)}
          </Text>
        </View>
        <RiskBadge level={listing.risk_profile} />
      </View>

      <View style={styles.pills}>
        {(listing.markets ?? []).map((m) => (
          <Pill key={m} label={m} tone="navy" />
        ))}
        {listing.duration_days ? <Pill label={formatDuration(listing.duration_days)} /> : null}
        {isService && listing.commission_bps != null ? (
          <Pill label={`${formatBps(listing.commission_bps)} commission`} />
        ) : null}
        {!isService && listing.amount ? (
          <Pill label={formatAmount(listing.amount, assetCode)} />
        ) : null}
        {isService && listing.min_capital ? (
          <Pill label={`min ${formatAmount(listing.min_capital, assetCode)}`} />
        ) : null}
      </View>

      <View style={styles.stats}>
        <Metric label="Views" value={listing.view_count ?? 0} />
        <Metric label="Likes" value={listing.like_count ?? 0} />
        <Metric label="Offers" value={listing.offer_count ?? 0} />
      </View>

      <View style={styles.actions}>
        <Button title="Open" variant="secondary" size="sm" onPress={onOpen} />
        <View style={{ flex: 1 }} />
        {listing.status === 'active' ? (
          <Button
            title="Pause"
            variant="ghost"
            size="sm"
            loading={busy}
            onPress={() => onStatus('pause')}
          />
        ) : null}
        {listing.status === 'paused' ? (
          <Button
            title="Resume"
            variant="ghost"
            size="sm"
            loading={busy}
            onPress={() => onStatus('resume')}
          />
        ) : null}
        {listing.status !== 'closed' ? (
          <Button
            title="Close"
            variant="danger"
            size="sm"
            loading={busy}
            onPress={() => onStatus('close')}
          />
        ) : null}
      </View>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metric}>
      <Text variant="numericSm">{value}</Text>
      <Text variant="caption" color="text3">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  list: { gap: spacing.md },
  card: { gap: spacing.sm },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  stats: {
    flexDirection: 'row',
    gap: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  metric: { alignItems: 'flex-start', gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
