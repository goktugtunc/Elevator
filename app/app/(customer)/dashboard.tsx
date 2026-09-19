import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import {
  AsyncBoundary,
  EmptyState,
  HeaderActions,
  Screen,
  ScreenHeader,
} from '@/components/layout';
import { Button, Card, KpiBox, ListRow, RiskBadge, StatusChip, Text } from '@/components/ui';
import { dashboardApi } from '@/lib/api';
import type {
  CustomerDashboardOut,
  FollowedTraderOut,
  PositionBriefOut,
} from '@/lib/api/types';
import { formatAmount, formatBps, formatBpsSigned } from '@/lib/format';
import { colors, pnlColor, spacing } from '@/theme';

/**
 * Figma 5a/5b · Panel · Müşteri (node 30:97) — `GET /dashboard`.
 * Portföy değeri = açık pozisyonların değeri + cüzdan bakiyesi; takip edilen
 * trader'lar ve açık pozisyonlar sunucudan hazır gelir.
 */
export default function CustomerDashboard() {
  const router = useRouter();

  const dash = useQuery({
    queryKey: ['dashboard'],
    queryFn: dashboardApi.get,
    select: (d) => d as CustomerDashboardOut,
  });

  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Dashboard" subtitle="Your portfolio and the traders you follow"
        right={<HeaderActions />}
      />
      <View style={styles.body}>
        <AsyncBoundary query={dash}>
          {(d) => (
            <>
              <Card style={styles.hero}>
                <Text variant="caption" color="text2">
                  Portfolio value
                </Text>
                <Text variant="display">
                  {formatAmount(d.portfolio_value, d.base_asset_code)}
                </Text>
                <View style={styles.heroRow}>
                  <Text variant="numericSm" color={pnlColor(d.month_change_bps)}>
                    {formatAmount(d.month_pnl, d.base_asset_code)} (
                    {formatBpsSigned(d.month_change_bps)})
                  </Text>
                  <Text variant="caption" color="text3">
                    last 30 days
                  </Text>
                </View>
                {d.wallet_error ? (
                  <Text variant="caption" color="loss">
                    Wallet balance unavailable: {d.wallet_error}
                  </Text>
                ) : null}
              </Card>

              <View style={styles.kpis}>
                <KpiBox
                  label="Invested"
                  value={formatAmount(d.invested_principal, d.base_asset_code)}
                  sub={`${d.invested_count ?? 0} position${d.invested_count === 1 ? '' : 's'}`}
                  style={styles.kpi}
                />
                <KpiBox
                  label="Open P&L"
                  value={formatAmount(d.open_pnl, d.base_asset_code)}
                  signed={d.open_pnl_bps}
                  sub={formatBpsSigned(d.open_pnl_bps)}
                  style={styles.kpi}
                />
                <KpiBox
                  label="In positions"
                  value={formatAmount(d.positions_value, d.base_asset_code)}
                  style={styles.kpi}
                />
                <KpiBox
                  label="Wallet"
                  value={
                    d.wallet_balance
                      ? formatAmount(d.wallet_balance, d.base_asset_code)
                      : '—'
                  }
                  sub="available"
                  style={styles.kpi}
                />
              </View>

              <Section title="Open positions">
                {d.positions?.length ? (
                  <Card style={styles.list}>
                    {d.positions.map((p) => (
                      <PositionRow
                        key={p.agreement_id}
                        position={p}
                        onPress={() => router.push(`/contract/${p.agreement_id}`)}
                      />
                    ))}
                  </Card>
                ) : (
                  <EmptyState
                    title="No open positions"
                    body="Find a trader in Discover and send an offer to get started."
                    action={
                      <Button
                        title="Discover traders"
                        size="sm"
                        onPress={() => router.push('/(customer)/discover')}
                      />
                    }
                  />
                )}
              </Section>

              <Section
                title="Traders you follow"
                action={
                  d.followed_count ? (
                    <Text variant="caption" color="text3">
                      {d.followed_count} followed
                    </Text>
                  ) : null
                }
              >
                {d.followed?.length ? (
                  <Card style={styles.list}>
                    {d.followed.map((t) => (
                      <FollowedRow
                        key={t.trader_id}
                        trader={t}
                        baseAsset={d.base_asset_code}
                        onPress={() => router.push(`/trader/${t.trader_id}`)}
                      />
                    ))}
                  </Card>
                ) : (
                  <EmptyState
                    title="Not following anyone yet"
                    body="Swipe right in Discover to follow a trader and track their moves."
                  />
                )}
              </Section>

              <Section title="Your listing activity">
                <Card style={styles.interactions}>
                  <Metric label="Listings" value={d.listing_interactions.listings ?? 0} />
                  <Metric label="Views" value={d.listing_interactions.views ?? 0} />
                  <Metric label="Likes" value={d.listing_interactions.likes ?? 0} />
                  <Metric label="Offers" value={d.listing_interactions.offers ?? 0} />
                </Card>
              </Section>
            </>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function PositionRow({ position, onPress }: { position: PositionBriefOut; onPress: () => void }) {
  return (
    <ListRow
      title={position.counterparty_display_name}
      subtitle={`${formatAmount(position.principal, position.base_asset_code)} · ${formatBps(position.commission_bps)} commission`}
      initials={position.counterparty_display_name}
      trailing={
        <View style={styles.rowRight}>
          <Text variant="numericSm">
            {formatAmount(position.current_value, position.base_asset_code)}
          </Text>
          <Text variant="caption" color={pnlColor(position.pnl_bps)}>
            {formatBpsSigned(position.pnl_bps)}
          </Text>
          <StatusChip status={position.status} />
        </View>
      }
      chevron
      onPress={onPress}
    />
  );
}

function FollowedRow({
  trader,
  baseAsset,
  onPress,
}: {
  trader: FollowedTraderOut;
  baseAsset: string;
  onPress: () => void;
}) {
  const subtitle = trader.invested
    ? `Invested ${formatAmount(trader.invested_principal, baseAsset)}`
    : `@${trader.username}`;
  return (
    <ListRow
      title={trader.display_name}
      subtitle={subtitle}
      initials={trader.display_name}
      trailing={
        <View style={styles.rowRight}>
          <Text variant="numericSm" color={pnlColor(trader.total_return_bps ?? 0)}>
            {formatBpsSigned(trader.total_return_bps ?? 0)}
          </Text>
          <RiskBadge level={trader.risk_level} />
        </View>
      }
      chevron
      onPress={onPress}
    />
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="h2">{title}</Text>
        <View style={{ flex: 1 }} />
        {action}
      </View>
      {children}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metric}>
      <Text variant="numeric">{value}</Text>
      <Text variant="caption" color="text2">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.lg },
  hero: { gap: 2, backgroundColor: colors.surface },
  heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: spacing.xs },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kpi: { flexGrow: 1, flexBasis: '46%', minWidth: 0 },
  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  list: { paddingVertical: 0 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  interactions: { flexDirection: 'row', justifyContent: 'space-between' },
  metric: { alignItems: 'center', gap: 2, flex: 1 },
});
