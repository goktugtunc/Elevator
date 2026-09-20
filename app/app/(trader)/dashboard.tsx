import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  AsyncBoundary,
  EmptyState,
  HeaderActions,
  Screen,
  ScreenHeader,
} from '@/components/layout';
import { Button, Card, KpiBox, ListRow, Pill, Progress, StatusChip, Text } from '@/components/ui';
import { dashboardApi, offersApi } from '@/lib/api';
import type {
  PendingOfferBriefOut,
  PositionBriefOut,
  ProfileChecklistOut,
  TraderDashboardOut,
} from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { formatAmount, formatBps, formatBpsSigned, formatRelative } from '@/lib/format';
import { useRefetchOnFocus } from '@/lib/useRefetchOnFocus';
import { isPast, useNow } from '@/lib/useNow';
import { colors, pnlColor, radius, spacing } from '@/theme';

/**
 * Figma 5c · Panel · Trader (node 23:362) — `GET /dashboard`.
 * Sunucu rol'e göre `TraderDashboardOut` döndürür: yönetilen sermaye, açık K/Z,
 * bekleyen teklifler, ilan etkileşimleri ve profil tamamlama listesi.
 */
export default function TraderDashboard() {
  const router = useRouter();
  const qc = useQueryClient();

  // `role` ayırt edici alan; kör `as` dönüşümü yanlış gövdeyi doğruymuş gibi
  // gösterip role özgü alanlarda (profile_checklist) çökmeye yol açıyordu.
  const dash = useQuery({
    queryKey: ['dashboard', 'trader'],
    queryFn: dashboardApi.get,
    select: (d): TraderDashboardOut | null => (d.role === 'trader' ? d : null),
  });

  useRefetchOnFocus(dash.refetch);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['offers'] });
  };

  // Kabul, taslak sözleşmeyi doğurur ve sıradaki zincir üstü adımı söyler
  // (trader için `propose`); kullanıcı doğrudan sözleşme ekranına gider.
  const accept = useMutation({
    mutationFn: (offerId: string) => offersApi.accept(offerId),
    onSuccess: (res) => {
      refresh();
      router.push(`/contract/${res.agreement.id}`);
    },
  });

  const reject = useMutation({
    mutationFn: (offerId: string) => offersApi.reject(offerId),
    onSuccess: refresh,
  });

  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Dashboard" subtitle="Your capital, investors and open offers"
        right={<HeaderActions />}
      />
      <View style={styles.body}>
        <AsyncBoundary query={dash}>
          {(d) =>
            !d ? (
              <Text variant="caption" color="text2">
                Loading your trader profile…
              </Text>
            ) : (
            <>
              <View style={styles.kpis}>
                <KpiBox
                  label="Managed capital"
                  value={formatAmount(d.managed_capital, d.base_asset_code)}
                  sub={`${d.active_investors} active investor${d.active_investors === 1 ? '' : 's'}`}
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
                  label="Commission · 30d"
                  value={formatAmount(d.month_commission, d.base_asset_code)}
                  sub={`${formatAmount(d.total_commission, d.base_asset_code)} all time`}
                  style={styles.kpi}
                />
                <KpiBox
                  label="Settled"
                  value={String(d.settled_agreements)}
                  sub="agreements closed"
                  style={styles.kpi}
                />
              </View>

              <ProfileChecklist checklist={d.profile_checklist} />

              <Section
                title="Pending offers"
                count={d.pending_offers_count}
                action={
                  d.pending_offers_count > 0 ? (
                    <Button
                      title="See all"
                      variant="ghost"
                      size="sm"
                      onPress={() => router.push('/(trader)/listings')}
                    />
                  ) : null
                }
              >
                {d.pending_offers?.length ? (
                  <Card style={styles.list}>
                    {d.pending_offers.map((o) => (
                      <PendingOfferRow
                        key={o.offer_id}
                        offer={o}
                        busy={
                          (accept.isPending && accept.variables === o.offer_id) ||
                          (reject.isPending && reject.variables === o.offer_id)
                        }
                        onAccept={() => accept.mutate(o.offer_id)}
                        onReject={() => reject.mutate(o.offer_id)}
                      />
                    ))}
                  </Card>
                ) : (
                  <EmptyState
                    title="No pending offers"
                    body="Investors who like your service listing send offers here."
                  />
                )}
                {accept.isError || reject.isError ? (
                  <Text variant="caption" color="loss">
                    {userMessage(accept.error ?? reject.error)}
                  </Text>
                ) : null}
              </Section>

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
                    body="Accepted offers become agreements and show up here."
                  />
                )}
              </Section>

              <Section title="Listing interactions">
                <Card style={styles.interactions}>
                  <Metric label="Listings" value={d.listing_interactions?.listings ?? 0} />
                  <Metric label="Views" value={d.listing_interactions?.views ?? 0} />
                  <Metric label="Likes" value={d.listing_interactions?.likes ?? 0} />
                  <Metric label="Offers" value={d.listing_interactions?.offers ?? 0} />
                </Card>
              </Section>
            </>
            )
          }
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function ProfileChecklist({ checklist }: { checklist: ProfileChecklistOut | undefined }) {
  if (!checklist) return null;
  const items: { key: keyof ProfileChecklistOut; label: string }[] = [
    { key: 'wallet_connected', label: 'Wallet connected' },
    { key: 'has_avatar', label: 'Profile photo' },
    { key: 'has_strategy', label: 'Strategy summary' },
    { key: 'has_service_listing', label: 'Service listing published' },
    { key: 'has_trade', label: 'First trade recorded' },
  ];
  const pct = (checklist.completion_pct ?? 0) / 100;
  if (pct >= 1) return null;
  return (
    <Card style={styles.checklist}>
      <Progress value={pct} label={`Strengthen your profile · ${checklist.completion_pct ?? 0}%`} />
      {items.map(({ key, label }) => {
        const done = Boolean(checklist[key]);
        return (
          <View key={key} style={styles.checkRow}>
            <View style={[styles.checkDot, done && styles.checkDotDone]}>
              {done ? <Check size={12} color={colors.onNavy} /> : null}
            </View>
            <Text variant="caption" color={done ? 'text3' : 'text2'}>
              {label}
            </Text>
          </View>
        );
      })}
      <Text variant="caption" color="text3">
        Investors compare traders on these before sending an offer.
      </Text>
    </Card>
  );
}

function PendingOfferRow({
  offer,
  busy,
  onAccept,
  onReject,
}: {
  offer: PendingOfferBriefOut;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const now = useNow();
  const expired = isPast(offer.expires_at, now);
  return (
    <View style={styles.offer}>
      <ListRow
        title={offer.from_display_name}
        subtitle={`@${offer.from_username} · ${offer.duration_days} days · ${formatBps(offer.commission_bps)} commission`}
        initials={offer.from_display_name}
        value={formatAmount(offer.amount, offer.base_asset_code)}
        meta={expired ? 'Expired' : `Expires ${formatRelative(offer.expires_at)}`}
      />
      {expired ? null : (
        <View style={styles.offerActions}>
          <Button title="Decline" variant="secondary" size="sm" onPress={onReject} />
          <Button title="Accept" size="sm" loading={busy} onPress={onAccept} />
        </View>
      )}
    </View>
  );
}

function PositionRow({
  position,
  onPress,
}: {
  position: PositionBriefOut;
  onPress: () => void;
}) {
  return (
    <ListRow
      title={position.counterparty_display_name}
      subtitle={`${formatAmount(position.principal, position.base_asset_code)} · ${position.duration_days} days`}
      initials={position.counterparty_display_name}
      value={formatAmount(position.current_value, position.base_asset_code)}
      meta={formatBpsSigned(position.pnl_bps)}
      trailing={
        <View style={styles.positionRight}>
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

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="h2">{title}</Text>
        {count ? <Pill label={String(count)} tone="navy" /> : null}
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
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kpi: { flexGrow: 1, flexBasis: '46%', minWidth: 0 },
  checklist: { gap: spacing.sm },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  checkDot: {
    width: 18,
    height: 18,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDotDone: { backgroundColor: colors.profit, borderColor: colors.profit },
  section: { gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  list: { paddingVertical: 0 },
  offer: { gap: spacing.sm, paddingBottom: spacing.sm },
  offerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  positionRight: { alignItems: 'flex-end', gap: 2 },
  interactions: { flexDirection: 'row', justifyContent: 'space-between' },
  metric: { alignItems: 'center', gap: 2, flex: 1 },
});
