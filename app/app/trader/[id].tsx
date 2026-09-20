import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ExternalLink, Star } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { PortfolioCard } from '@/components/profile';
import {
  Avatar,
  Button,
  Card,
  KpiBox,
  ListRow,
  Pill,
  RiskBadge,
  Segmented,
  Sparkline,
  Text,
} from '@/components/ui';
import { tradersApi } from '@/lib/api';
import type { RatingOut, TradeBriefOut, TraderProfileOut } from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { formatAmount, formatBps, formatBpsSigned, formatRelative } from '@/lib/format';
import { explorerTxUrl } from '@/lib/stellar';
import { useSession } from '@/store/session';
import { colors, pnlColor, spacing } from '@/theme';

type Range = '7d' | '30d' | '90d' | '1y' | 'all';

const RANGES: { value: Range; label: string }[] = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '1M' },
  { value: '90d', label: '3M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];

/**
 * Figma 3 · Trader Profili (node 22:171) — `GET /traders/{id}/profile`.
 * KPI ızgarası, dönem seçmeli performans grafiği, canlı hareketler, strateji ve
 * yorumlar. Takip et/bırak `POST|DELETE /traders/{id}/follow`.
 */
export default function TraderProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const myRole = useSession((s) => s.role);
  const [range, setRange] = useState<Range>('30d');

  const profile = useQuery({
    queryKey: ['trader', id, range],
    queryFn: () => tradersApi.profile(id, { range, trades: 10 }),
    enabled: Boolean(id),
  });

  const follow = useMutation({
    mutationFn: (next: boolean) => (next ? tradersApi.follow(id) : tradersApi.unfollow(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trader', id] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  return (
    <Screen padded={false}>
      <TopBar title="Trader" />
      <View style={styles.body}>
        <AsyncBoundary query={profile}>
          {(p) => (
            <>
              <Header
                profile={p}
                busy={follow.isPending}
                onToggleFollow={() => follow.mutate(!p.is_following)}
                onMessage={() => router.push('/messages')}
                canFollow={myRole === 'customer'}
              />
              {follow.isError ? (
                <Text variant="caption" color="loss">
                  {userMessage(follow.error)}
                </Text>
              ) : null}

              <Stats profile={p} />

              <Card style={styles.chart}>
                <View style={styles.chartHead}>
                  <Text variant="captionStrong" color="text2">
                    Performance
                  </Text>
                  <Text
                    variant="numericSm"
                    color={pnlColor(p.performance.at(-1)?.return_bps ?? 0)}
                  >
                    {formatBpsSigned(p.performance.at(-1)?.return_bps ?? 0)}
                  </Text>
                </View>
                {p.performance.length > 1 ? (
                  <Sparkline
                    data={p.performance.map((pt) => Number(pt.value))}
                    height={64}
                    color={pnlColor(p.performance.at(-1)?.return_bps ?? 0)}
                  />
                ) : (
                  <Text variant="caption" color="text3">
                    Not enough history for this range yet.
                  </Text>
                )}
                <Segmented options={RANGES} value={range} onChange={setRange} />
              </Card>

              {p.user.strategy_summary ? (
                <Card style={styles.strategy}>
                  <Text variant="captionStrong" color="text2">
                    Strategy
                  </Text>
                  <Text variant="body">{p.user.strategy_summary}</Text>
                </Card>
              ) : null}

              <PortfolioCard text={p.user.portfolio} />

              <Section title="Live trades">
                {p.recent_trades.length ? (
                  <Card style={styles.list}>
                    {p.recent_trades.map((t) => (
                      <TradeRow key={t.id} trade={t} />
                    ))}
                  </Card>
                ) : (
                  <EmptyState title="No trades in this range" />
                )}
              </Section>

              <Section
                title="Reviews"
                meta={
                  p.ratings.count > 0
                    ? `${Number(p.ratings.avg).toFixed(1)} · ${p.ratings.count} review${p.ratings.count === 1 ? '' : 's'}`
                    : undefined
                }
              >
                {p.recent_ratings.length ? (
                  <Card style={styles.list}>
                    {p.recent_ratings.map((r) => (
                      <RatingRow key={r.id} rating={r} />
                    ))}
                  </Card>
                ) : (
                  <EmptyState
                    title="No reviews yet"
                    body="Customers can rate a trader once an agreement settles."
                  />
                )}
              </Section>
            </>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function Header({
  profile: p,
  busy,
  canFollow,
  onToggleFollow,
  onMessage,
}: {
  profile: TraderProfileOut;
  busy: boolean;
  canFollow: boolean;
  onToggleFollow: () => void;
  onMessage: () => void;
}) {
  return (
    <Card style={styles.header}>
      <View style={styles.headerTop}>
        <Avatar initials={p.user.display_name} size="lg" />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="h1">{p.user.display_name}</Text>
          <Text variant="caption" color="text3">
            @{p.user.username} · {p.follower_count} follower{p.follower_count === 1 ? '' : 's'}
          </Text>
        </View>
        <RiskBadge level={p.user.risk_level} />
      </View>

      <View style={styles.pills}>
        {(p.user.markets ?? []).map((m) => (
          <Pill key={m} label={m} tone="navy" />
        ))}
        {p.user.commission_bps != null ? (
          <Pill label={`${formatBps(p.user.commission_bps)} commission`} />
        ) : null}
        {p.user.min_capital ? <Pill label={`min ${p.user.min_capital}`} /> : null}
        {p.active_listings ? <Pill label={`${p.active_listings} active listings`} /> : null}
      </View>

      <View style={styles.headerActions}>
        {canFollow ? (
          <Button
            title={p.is_following ? 'Following' : 'Follow'}
            variant={p.is_following ? 'secondary' : 'primary'}
            loading={busy}
            onPress={onToggleFollow}
          />
        ) : null}
        <Button title="Message" variant="secondary" onPress={onMessage} />
      </View>
    </Card>
  );
}

function Stats({ profile: p }: { profile: TraderProfileOut }) {
  const s = p.stats;
  return (
    <View style={styles.kpis}>
      <KpiBox
        label="Total return"
        value={formatBpsSigned(s.total_return_bps ?? 0)}
        signed={s.total_return_bps ?? 0}
        style={styles.kpi}
      />
      <KpiBox
        label="Monthly"
        value={formatBpsSigned(s.monthly_return_bps ?? 0)}
        signed={s.monthly_return_bps ?? 0}
        style={styles.kpi}
      />
      <KpiBox
        label="Max drawdown"
        value={formatBps(s.max_drawdown_bps ?? 0)}
        style={styles.kpi}
      />
      <KpiBox label="Win rate" value={formatBps(s.win_rate_bps ?? 0)} style={styles.kpi} />
      <KpiBox
        label="Managed capital"
        value={formatAmount(s.managed_capital, '')}
        sub={`${s.active_agreements ?? 0} active`}
        style={styles.kpi}
      />
      <KpiBox
        label="Rating"
        value={s.rating_count ? Number(s.rating_avg).toFixed(1) : '—'}
        sub={`${s.rating_count ?? 0} reviews`}
        style={styles.kpi}
      />
    </View>
  );
}

function TradeRow({ trade }: { trade: TradeBriefOut }) {
  return (
    <ListRow
      title={trade.symbol_label}
      subtitle={trade.note ?? formatRelative(trade.created_at)}
      value={`${trade.amount_in} → ${trade.amount_out}`}
      trailing={trade.tx_hash ? <ExternalLink size={16} color={colors.text3} /> : undefined}
      onPress={
        trade.tx_hash ? () => void Linking.openURL(explorerTxUrl(trade.tx_hash as string)) : undefined
      }
    />
  );
}

function RatingRow({ rating }: { rating: RatingOut }) {
  return (
    <View style={styles.rating}>
      <View style={styles.ratingHead}>
        <Text variant="bodyStrong">{rating.customer_display_name ?? 'Anonymous'}</Text>
        <View style={styles.stars}>
          <Star size={13} color={colors.amber} fill={colors.amber} />
          <Text variant="captionStrong">{rating.score}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text variant="caption" color="text3">
          {formatRelative(rating.created_at)}
        </Text>
      </View>
      {rating.comment ? (
        <Text variant="caption" color="text2">
          {rating.comment}
        </Text>
      ) : null}
    </View>
  );
}

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="h2">{title}</Text>
        <View style={{ flex: 1 }} />
        {meta ? (
          <Text variant="caption" color="text2">
            {meta}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  header: { gap: spacing.sm },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  headerActions: { flexDirection: 'row', gap: spacing.sm },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kpi: { flexGrow: 1, flexBasis: '30%', minWidth: 0 },
  chart: { gap: spacing.sm },
  chartHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  strategy: { gap: spacing.xs },
  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  list: { paddingVertical: 0 },
  rating: { gap: 4, paddingVertical: spacing.sm },
  ratingHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stars: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
