import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ExternalLink, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, ScreenHeader } from '@/components/layout';
import { NewTradeSheet } from '@/components/trades';
import { Button, Card, KpiBox, ListRow, Segmented, StatusChip, Text } from '@/components/ui';
import { activityApi, agreementsApi, dashboardApi } from '@/lib/api';
import type { ActivityItemOut, AgreementOut, TraderDashboardOut } from '@/lib/api/types';
import { formatAmount, formatBpsSigned, formatRelative } from '@/lib/format';
import { explorerTxUrl } from '@/lib/stellar';
import { colors, pnlColor, spacing } from '@/theme';

type Tab = 'open' | 'history';

/**
 * Figma 5a/5b · İşlemler · Trader (node 23:45) — açık pozisyonlar ve işlem geçmişi.
 * Yeni işlem sheet'i (23:181) seçilen sözleşme üzerinden çalışır; imza ve
 * gönderim `lib/onchain` üzerinden yürür.
 */
export default function TraderTrades() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('open');
  const [tradeOn, setTradeOn] = useState<AgreementOut | null>(null);

  const dash = useQuery({
    queryKey: ['dashboard'],
    queryFn: dashboardApi.get,
    select: (d) => d as TraderDashboardOut,
  });

  const agreements = useQuery({
    queryKey: ['agreements', 'active'],
    queryFn: () => agreementsApi.list({ status: 'active', limit: 50 }),
    enabled: tab === 'open',
  });

  const history = useQuery({
    queryKey: ['activity', 'mine'],
    queryFn: () => activityApi.feed({ limit: 50 }),
    enabled: tab === 'history',
  });

  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Trades" subtitle="Capital you manage and every trade you opened" />
      <View style={styles.body}>
        {dash.data ? (
          <View style={styles.kpis}>
            <KpiBox
              label="Open P&L"
              value={formatAmount(dash.data.open_pnl, dash.data.base_asset_code)}
              signed={dash.data.open_pnl_bps}
              sub={formatBpsSigned(dash.data.open_pnl_bps)}
              style={styles.kpi}
            />
            <KpiBox
              label="Managed"
              value={formatAmount(dash.data.managed_capital, dash.data.base_asset_code)}
              sub={`${dash.data.active_investors} investors`}
              style={styles.kpi}
            />
          </View>
        ) : null}

        <Segmented
          options={[
            { value: 'open' as Tab, label: 'Open positions' },
            { value: 'history' as Tab, label: 'History' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'open' ? (
          <AsyncBoundary
            query={agreements}
            isEmpty={(page) => page.items.length === 0}
            empty={
              <EmptyState
                title="No active agreements"
                body="Accept an offer and fund the escrow before you can trade."
              />
            }
          >
            {(page) => (
              <View style={styles.list}>
                {page.items.map((a) => (
                  <AgreementCard
                    key={a.id}
                    agreement={a}
                    onTrade={() => setTradeOn(a)}
                    onOpen={() => router.push(`/contract/${a.id}`)}
                  />
                ))}
              </View>
            )}
          </AsyncBoundary>
        ) : (
          <AsyncBoundary
            query={history}
            isEmpty={(page) => page.items.length === 0}
            empty={
              <EmptyState
                title="No trades yet"
                body="Your trades show up here with their on-chain hash as soon as they settle."
              />
            }
          >
            {(page) => (
              <Card style={styles.card}>
                {page.items.map((item) => (
                  <TradeRow key={item.trade.id} item={item} />
                ))}
              </Card>
            )}
          </AsyncBoundary>
        )}
      </View>

      {tradeOn ? (
        <NewTradeSheet
          agreement={tradeOn}
          visible={Boolean(tradeOn)}
          onClose={() => setTradeOn(null)}
        />
      ) : null}
    </Screen>
  );
}

function AgreementCard({
  agreement: a,
  onTrade,
  onOpen,
}: {
  agreement: AgreementOut;
  onTrade: () => void;
  onOpen: () => void;
}) {
  const code = a.base_asset.code;
  return (
    <Card style={styles.agreement}>
      <View style={styles.agreementHead}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyStrong">{a.customer.display_name}</Text>
          <Text variant="caption" color="text3">
            {formatAmount(a.principal, code)} ·{' '}
            {a.seconds_remaining != null
              ? `${Math.max(0, Math.ceil(a.seconds_remaining / 86400))} days left`
              : `${a.duration_days} days`}
          </Text>
        </View>
        <StatusChip status={a.status} />
      </View>

      <View style={styles.agreementValues}>
        <View style={{ flex: 1 }}>
          <Text variant="caption" color="text2">
            Value
          </Text>
          <Text variant="numeric">{formatAmount(a.current_value ?? a.principal, code)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="caption" color="text2">
            P&L
          </Text>
          <Text variant="numeric" color={pnlColor(a.pnl_bps ?? 0)}>
            {formatBpsSigned(a.pnl_bps ?? 0)}
          </Text>
        </View>
      </View>

      <View style={styles.agreementActions}>
        <Button title="Details" variant="secondary" size="sm" onPress={onOpen} />
        <View style={{ flex: 1 }} />
        <Button
          title="New trade"
          size="sm"
          onPress={onTrade}
          leftIcon={<Plus size={16} color={colors.onNavy} />}
        />
      </View>
    </Card>
  );
}

function TradeRow({ item }: { item: ActivityItemOut }) {
  const t = item.trade;
  return (
    <ListRow
      title={t.symbol_label ?? `${t.token_in.code} → ${t.token_out.code}`}
      subtitle={`${item.customer?.display_name ?? item.trader.display_name} · ${formatRelative(t.created_at)}`}
      value={`${t.amount_in} → ${t.amount_out}`}
      meta={t.value_after ? `Value ${formatAmount(t.value_after, item.base_asset_code)}` : undefined}
      trailing={t.tx_hash ? <ExternalLink size={16} color={colors.text3} /> : undefined}
      onPress={t.tx_hash ? () => void Linking.openURL(explorerTxUrl(t.tx_hash as string)) : undefined}
    />
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  kpis: { flexDirection: 'row', gap: spacing.sm },
  kpi: { flex: 1 },
  list: { gap: spacing.md },
  card: { paddingVertical: 0 },
  agreement: { gap: spacing.sm },
  agreementHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  agreementValues: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  agreementActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
