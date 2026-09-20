import { useQuery } from '@tanstack/react-query';
import { ExternalLink, SlidersHorizontal } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import {
  AsyncBoundary,
  EmptyState,
  HeaderActions,
  Screen,
  ScreenHeader,
} from '@/components/layout';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  ListRow,
  Segmented,
  Switch,
  Text,
} from '@/components/ui';
import { activityApi, dashboardApi } from '@/lib/api';
import type { ActivityItemOut, CustomerDashboardOut } from '@/lib/api/types';
import { formatAmount, formatRelative } from '@/lib/format';
import { explorerTxUrl } from '@/lib/stellar';
import { colors, spacing } from '@/theme';

type State = 'all' | 'open' | 'closed';

/**
 * Figma 4a/4b · Hareketler (node 30:252 · 30:375) + "Görünümü Düzenle" (30:536).
 * `GET /activity` hem yatırım yaptığın hem de takip ettiğin trader'ların
 * işlemlerini verir; `relation` alanı ikisini ayırır.
 */
export default function CustomerActivity() {
  const [state, setState] = useState<State>('all');
  const [traderId, setTraderId] = useState<string | null>(null);
  const [onlyInvested, setOnlyInvested] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const dash = useQuery({
    queryKey: ['dashboard', 'customer'],
    queryFn: dashboardApi.get,
    select: (d): CustomerDashboardOut | null => (d.role === 'customer' ? d : null),
  });

  const activity = useQuery({
    queryKey: ['activity', state, traderId],
    queryFn: () =>
      activityApi.feed({
        limit: 50,
        state: state === 'all' ? undefined : state,
        trader_id: traderId ?? undefined,
      }),
  });

  const items = useMemo(() => {
    const all = activity.data?.items ?? [];
    return onlyInvested ? all.filter((i) => i.relation === 'party') : all;
  }, [activity.data, onlyInvested]);

  const followed = dash.data?.followed ?? [];
  const activeFilters = (traderId ? 1 : 0) + (onlyInvested ? 1 : 0);

  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader
        title="Activity"
        subtitle="Every move by the traders you follow or invest with"
        right={
          <View style={styles.headerActions}>
            <HeaderActions />
            <Button
              title={activeFilters ? `Filters (${activeFilters})` : 'Filters'}
              variant="secondary"
              size="sm"
              onPress={() => setSheetOpen(true)}
              leftIcon={<SlidersHorizontal size={15} color={colors.navy900} />}
            />
          </View>
        }
      />
      <View style={styles.body}>
        <Segmented
          options={[
            { value: 'all' as State, label: 'All' },
            { value: 'open' as State, label: 'Open' },
            { value: 'closed' as State, label: 'Closed' },
          ]}
          value={state}
          onChange={setState}
        />

        <AsyncBoundary
          query={activity}
          isEmpty={() => items.length === 0}
          empty={
            <EmptyState
              title="Nothing here yet"
              body={
                activeFilters
                  ? 'No activity matches these filters.'
                  : 'Follow a trader in the Elevator to see their trades as they happen.'
              }
              action={
                activeFilters ? (
                  <Button
                    title="Clear filters"
                    variant="secondary"
                    size="sm"
                    onPress={() => {
                      setTraderId(null);
                      setOnlyInvested(false);
                    }}
                  />
                ) : null
              }
            />
          }
        >
          {() => (
            <Card style={styles.card}>
              {items.map((item) => (
                <ActivityRow key={item.trade.id} item={item} />
              ))}
            </Card>
          )}
        </AsyncBoundary>
      </View>

      <BottomSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Edit view"
        subtitle="Narrow the feed down to what you care about"
        footer={
          <Button title="Done" fullWidth onPress={() => setSheetOpen(false)} />
        }
      >
        <View style={styles.sheet}>
          <View style={styles.group}>
            <Text variant="captionStrong" color="text2">
              Trader
            </Text>
            <View style={styles.chips}>
              <Chip label="All traders" active={!traderId} onPress={() => setTraderId(null)} />
              {followed.map((t) => (
                <Chip
                  key={t.trader_id}
                  label={t.display_name}
                  active={traderId === t.trader_id}
                  onPress={() => setTraderId(t.trader_id)}
                />
              ))}
            </View>
            {followed.length === 0 ? (
              <Text variant="caption" color="text3">
                You are not following anyone yet.
              </Text>
            ) : null}
          </View>

          <Switch
            value={onlyInvested}
            onValueChange={setOnlyInvested}
            label="Only where my capital is at work"
            hint="Hides traders you follow but have not invested with."
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}

function ActivityRow({ item }: { item: ActivityItemOut }) {
  const t = item.trade;
  const invested = item.relation === 'party';
  return (
    <ListRow
      title={t.symbol_label ?? `${t.token_in.code} → ${t.token_out.code}`}
      subtitle={`${item.trader.display_name} · ${formatRelative(t.created_at)}${
        invested ? ' · your capital' : ''
      }`}
      initials={item.trader.display_name}
      value={`${t.amount_in} → ${t.amount_out}`}
      meta={t.value_after ? `Value ${formatAmount(t.value_after, item.base_asset_code)}` : undefined}
      trailing={t.tx_hash ? <ExternalLink size={16} color={colors.text3} /> : undefined}
      onPress={t.tx_hash ? () => void Linking.openURL(explorerTxUrl(t.tx_hash as string)) : undefined}
    />
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  card: { paddingVertical: 0 },
  sheet: { gap: spacing.lg },
  group: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
