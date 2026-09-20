import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ExternalLink } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  ErrorNotice,
  Field,
  KpiBox,
  ListRow,
  Pill,
  Progress,
  Segmented,
  SlideToConfirm,
  Sparkline,
  StatusChip,
  Text,
} from '@/components/ui';
import { agreementsApi, metaApi } from '@/lib/api';
import type { AgreementOut, AgreementStatus, AssetOut, TradeOut } from '@/lib/api/types';
import {
  assetLabel,
  formatAmount,
  formatBps,
  formatBpsSigned,
  formatRelative,
  parseNumberInput,
} from '@/lib/format';
import { phaseLabel, useOnchainAction } from '@/lib/onchain';
import { explorerTxUrl } from '@/lib/stellar';
import { colors, pnlColor, radius, spacing } from '@/theme';

type Tab = 'overview' | 'trades';

/** Zincir üstü adımların kullanıcıya görünen adı ve açıklaması. */
const ACTION_COPY: Record<string, { title: string; slide: string; body: string; danger?: boolean }> = {
  open: {
    title: 'Fund the escrow',
    slide: 'Slide to fund',
    body: 'Your capital moves into the escrow contract. The trader can trade it but cannot withdraw it.',
  },
  propose: {
    title: 'Propose the agreement',
    slide: 'Slide to propose',
    body: 'Writes the agreed terms on-chain. The customer funds the escrow next.',
  },
  fund: {
    title: 'Fund the escrow',
    slide: 'Slide to fund',
    body: 'Your capital moves into the escrow contract and the agreement becomes active.',
  },
  accept: {
    title: 'Accept and start',
    slide: 'Slide to accept',
    body: 'Confirms the terms on-chain and starts the agreement clock.',
  },
  trade: {
    title: 'Open a trade',
    slide: 'Slide to trade',
    body: 'Swaps inside the escrow through the allow-listed router. The capital never leaves the contract.',
  },
  settle: {
    title: 'Settle the agreement',
    slide: 'Slide to settle',
    body: 'Closes the positions, pays the commission and returns the rest to the customer.',
  },
  cancel: {
    title: 'Cancel the agreement',
    slide: 'Slide to cancel',
    body: 'Ends the agreement before it starts and returns any escrowed capital.',
    danger: true,
  },
};

const STEPS: AgreementStatus[] = ['draft', 'proposed', 'funded', 'active', 'settled'];

/**
 * Figma 7 · Sözleşme (node 28:320) — `GET /agreements/{id}`.
 *
 * Zincir üstü akış tek desen: sunucu XDR üretir → cüzdan imzalar →
 * `POST /tx/submit`. Hangi adımın mümkün olduğunu sunucu `available_actions`
 * ile söyler; arayüz kendi başına karar vermez.
 */
export default function Contract() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [action, setAction] = useState<string | null>(null);

  const agreement = useQuery({
    queryKey: ['agreement', id],
    queryFn: () => agreementsApi.byId(id, true),
    enabled: Boolean(id),
  });

  const history = useQuery({
    queryKey: ['agreement', id, 'history'],
    queryFn: () => agreementsApi.valueHistory(id, '30d'),
    enabled: Boolean(id) && agreement.data?.status === 'active',
  });

  const trades = useQuery({
    queryKey: ['agreement', id, 'trades'],
    queryFn: () => agreementsApi.trades(id, { limit: 50 }),
    enabled: Boolean(id) && tab === 'trades',
  });

  /**
   * `trade` diğer eylemler gibi tek dokunuşluk değil: hangi varlıktan hangisine,
   * ne kadar ve hangi kayma payıyla sorularının yanıtı gerekiyor. Bu yüzden
   * kaydırmalı onay yerine kendi panelini açar.
   */
  const [tradeOpen, setTradeOpen] = useState(false);

  const tx = useOnchainAction({
    build: () => agreementsApi.buildTx(id, action as string),
    invalidate: [['agreement', id], ['dashboard'], ['agreements']],
    onSuccess: (res) => {
      if (res.ok) {
        setAction(null);
        void qc.invalidateQueries({ queryKey: ['agreement', id] });
      }
    },
  });

  return (
    <Screen padded={false}>
      <TopBar title="Agreement" />
      <View style={styles.body}>
        <AsyncBoundary query={agreement}>
          {(a) => (
            <>
              <Header agreement={a} />
              <Timeline status={a.status} />

              <Segmented
                options={[
                  { value: 'overview' as Tab, label: 'Overview' },
                  { value: 'trades' as Tab, label: 'Trades' },
                ]}
                value={tab}
                onChange={setTab}
              />

              {tab === 'overview' ? (
                <>
                  {a.status === 'active' && history.data?.points.length ? (
                    <Card style={styles.chart}>
                      <Text variant="captionStrong" color="text2">
                        Value · last 30 days
                      </Text>
                      <Sparkline
                        data={history.data.points.map((p) => Number(p.value))}
                        color={pnlColor(a.pnl_bps ?? 0)}
                      />
                    </Card>
                  ) : null}

                  <Terms agreement={a} />

                  {a.tl ? <TryValues agreement={a} /> : null}

                  {a.pending_tx ? (
                    <Card style={styles.pending}>
                      <Text variant="captionStrong">Transaction in progress</Text>
                      <Text variant="caption" color="text2">
                        A {a.pending_tx.kind} transaction is {a.pending_tx.status}. Refresh in a
                        moment to see the result.
                      </Text>
                      <Button
                        title="Refresh"
                        variant="secondary"
                        size="sm"
                        onPress={() => agreement.refetch()}
                      />
                    </Card>
                  ) : null}

                  <Actions
                    agreement={a}
                    selected={action}
                    onSelect={(next) => {
                      tx.reset();
                      setAction(next);
                    }}
                    onTrade={() => {
                      setAction(null);
                      setTradeOpen(true);
                    }}
                    tx={tx}
                  />

                  <TradeSheet
                    agreement={a}
                    visible={tradeOpen}
                    onClose={() => setTradeOpen(false)}
                    onDone={() => {
                      setTradeOpen(false);
                      void qc.invalidateQueries({ queryKey: ['agreement', id] });
                      setTab('trades');
                    }}
                  />

                  <TxLinks agreement={a} />
                </>
              ) : (
                <AsyncBoundary
                  query={trades}
                  isEmpty={(page) => page.items.length === 0}
                  empty={
                    <EmptyState
                      title="No trades yet"
                      body="Trades the trader opens on this capital appear here with their on-chain hash."
                    />
                  }
                >
                  {(page) => (
                    <Card style={styles.list}>
                      {page.items.map((t) => (
                        <TradeRow key={t.id} trade={t} />
                      ))}
                    </Card>
                  )}
                </AsyncBoundary>
              )}

              {a.my_role ? (
                <Button
                  title="Open conversation"
                  variant="secondary"
                  fullWidth
                  onPress={() => router.push('/messages')}
                />
              ) : null}
            </>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function Header({ agreement: a }: { agreement: AgreementOut }) {
  const code = a.base_asset.code;
  const value = a.current_value ?? a.final_value ?? a.principal;
  return (
    <Card style={styles.header}>
      <View style={styles.headerTop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="caption" color="text2">
            {a.customer.display_name} → {a.trader.display_name}
          </Text>
          <Text variant="display">{formatAmount(value, code)}</Text>
        </View>
        <StatusChip status={a.status} />
      </View>
      <View style={styles.kpis}>
        <KpiBox label="Principal" value={formatAmount(a.principal, code)} style={styles.kpi} />
        <KpiBox
          label="P&L"
          value={formatAmount(a.pnl ?? '0', code)}
          signed={a.pnl_bps ?? 0}
          sub={formatBpsSigned(a.pnl_bps ?? 0)}
          style={styles.kpi}
        />
      </View>
      {a.status === 'active' && a.seconds_remaining != null ? (
        <Progress
          value={1 - a.seconds_remaining / a.duration_secs}
          label={`${Math.max(0, Math.ceil(a.seconds_remaining / 86400))} days remaining`}
        />
      ) : null}
      {a.drawdown_bps ? (
        <Text variant="caption" color={a.drawdown_bps > a.max_drawdown_bps * 0.8 ? 'loss' : 'text2'}>
          Drawdown {formatBps(a.drawdown_bps)} of {formatBps(a.max_drawdown_bps)} allowed · floor{' '}
          {formatAmount(a.drawdown_floor, code)}
        </Text>
      ) : null}
    </Card>
  );
}

function Timeline({ status }: { status: AgreementStatus }) {
  if (status === 'cancelled' || status === 'failed') {
    return (
      <Card style={styles.timelineEnded}>
        <Text variant="captionStrong" color="loss">
          {status === 'cancelled' ? 'This agreement was cancelled.' : 'This agreement failed.'}
        </Text>
      </Card>
    );
  }
  const index = STEPS.indexOf(status);
  return (
    <View style={styles.timeline}>
      {STEPS.map((s, i) => (
        <View key={s} style={styles.timelineStep}>
          <View
            style={[
              styles.timelineDot,
              i <= index && styles.timelineDotDone,
              i === index && styles.timelineDotNow,
            ]}
          />
          <Text variant="caption" color={i <= index ? 'text' : 'text3'}>
            {s}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Terms({ agreement: a }: { agreement: AgreementOut }) {
  const code = a.base_asset.code;
  const rows: { label: string; value: string }[] = [
    { label: 'Customer', value: `@${a.customer.username}` },
    { label: 'Trader', value: `@${a.trader.username}` },
    { label: 'Principal', value: formatAmount(a.principal, code) },
    { label: 'Duration', value: `${a.duration_days} days` },
    { label: 'Commission', value: formatBps(a.commission_bps) },
    { label: 'Max drawdown', value: formatBps(a.max_drawdown_bps) },
    { label: 'Base asset', value: code },
  ];
  if (a.start_time) rows.push({ label: 'Started', value: formatRelative(a.start_time) });
  if (a.settled_at) {
    rows.push(
      { label: 'Settled', value: formatRelative(a.settled_at) },
      { label: 'Final value', value: formatAmount(a.final_value, code) },
      { label: 'Trader fee', value: formatAmount(a.trader_fee, code) },
      { label: 'Platform fee', value: formatAmount(a.platform_fee, code) },
      { label: 'Customer payout', value: formatAmount(a.customer_payout, code) },
    );
  }
  return (
    <Card style={styles.list}>
      {rows.map((r) => (
        <View key={r.label} style={styles.detailRow}>
          <Text variant="caption" color="text2">
            {r.label}
          </Text>
          <Text variant="bodyStrong">{r.value}</Text>
        </View>
      ))}
    </Card>
  );
}

function TryValues({ agreement: a }: { agreement: AgreementOut }) {
  const tl = a.tl;
  if (!tl) return null;
  return (
    <Card style={styles.try}>
      <View style={styles.tryHead}>
        <Text variant="captionStrong" color="text2">
          In Turkish lira
        </Text>
        <Pill label={tl.stale ? `${tl.rate_source} · stale` : tl.rate_source} />
      </View>
      <View style={styles.tryRow}>
        {tl.principal_try ? <Figure label="Principal" value={`₺${tl.principal_try}`} /> : null}
        {tl.current_value_try ? <Figure label="Value" value={`₺${tl.current_value_try}`} /> : null}
        {tl.pnl_try ? <Figure label="P&L" value={`₺${tl.pnl_try}`} /> : null}
        {tl.customer_payout_try ? (
          <Figure label="Payout" value={`₺${tl.customer_payout_try}`} />
        ) : null}
      </View>
      <Text variant="caption" color="text3">
        Converted at {tl.rate} TRY/USD for display only; the agreement settles in{' '}
        {a.base_asset.code}.
      </Text>
    </Card>
  );
}

function Actions({
  agreement: a,
  selected,
  onSelect,
  onTrade,
  tx,
}: {
  agreement: AgreementOut;
  selected: string | null;
  onSelect: (action: string | null) => void;
  onTrade: () => void;
  tx: ReturnType<typeof useOnchainAction>;
}) {
  const actions = a.available_actions ?? [];
  if (!a.my_role) {
    return (
      <Text variant="caption" color="text3">
        You are not a party to this agreement.
      </Text>
    );
  }
  if (actions.length === 0) {
    return (
      <Text variant="caption" color="text3">
        Nothing to do right now — waiting on the other party or on the chain.
      </Text>
    );
  }

  // `trade` kendi panelinde yürür; burada kaydırmalı onay çizilmez.
  const copy = selected && selected !== 'trade' ? ACTION_COPY[selected] : null;

  return (
    <Card style={styles.actions}>
      <Text variant="h2">Next step</Text>
      <View style={styles.actionChips}>
        {actions.map((name) => (
          <Button
            key={name}
            title={ACTION_COPY[name]?.title ?? name}
            variant={selected === name ? 'primary' : 'secondary'}
            size="sm"
            onPress={() =>
              name === 'trade' ? onTrade() : onSelect(selected === name ? null : name)
            }
          />
        ))}
      </View>

      {copy ? (
        <>
          <Text variant="caption" color="text2">
            {copy.body}
          </Text>
          <SlideToConfirm
            label={copy.slide}
            onConfirm={tx.run}
            disabled={tx.busy}
            tone={copy.danger ? 'danger' : 'primary'}
          />
          {tx.busy ? (
            <Text variant="caption" color="text2">
              {phaseLabel(tx.phase)}
            </Text>
          ) : null}
          {tx.error ? <ErrorNotice title="Transaction failed" error={tx.error} /> : null}
          {tx.result?.ok ? (
            <Text variant="caption" color={colors.profit}>
              Done — the agreement is now {tx.result.agreement_status ?? a.status}.
            </Text>
          ) : null}
          <Text variant="caption" color="text3">
            Your wallet signs this transaction; your secret key never leaves the device.
          </Text>
        </>
      ) : null}
    </Card>
  );
}

/**
 * İşlem açma paneli.
 *
 * Trader parayı çekemez, yalnızca kasanın içinde izinli router üzerinden takas
 * eder. Kontrat, işlem sonrası portföy değeri maks. kayıp tabanının altına
 * düşecekse takası reddeder; bu yüzden imzadan önce sunucudan kotasyon alınır
 * ve `allowed` / `reason` olduğu gibi gösterilir — kullanıcı reddedilecek bir
 * işlemi imzalamaya çalışıp ücret ödemesin.
 */
function TradeSheet({
  agreement: a,
  visible,
  onClose,
  onDone,
}: {
  agreement: AgreementOut;
  visible: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  // Varlıklar **kimlikle** tutulur, koduyla değil: testnet'te iki ayrı USDC var
  // ve sunucu kod gönderilince `ambiguous_token` ile reddediyor.
  const [tokenIn, setTokenIn] = useState<string | null>(null);
  const [tokenOut, setTokenOut] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  const assets = useQuery({ queryKey: ['assets', 'all'], queryFn: () => metaApi.assets(), enabled: visible });

  /** Kasada bakiyesi olan varlıklar — satılabilecek olanlar. */
  const holdings = (a.balances ?? []).filter((b) => Number(b.balance) > 0);
  const inAsset = holdings.find((b) => b.asset.id === tokenIn)?.asset ?? holdings[0]?.asset ?? a.base_asset;
  const inBalance = holdings.find((b) => b.asset.id === inAsset.id)?.balance ?? '0';

  const outOptions: AssetOut[] = (assets.data ?? []).filter((x) => x.id !== inAsset.id);
  const outAsset = outOptions.find((x) => x.id === tokenOut) ?? outOptions[0] ?? null;

  const value = parseNumberInput(amount);
  const canQuote = Boolean(outAsset) && value !== null && value > 0 && value <= Number(inBalance);

  const quote = useQuery({
    queryKey: ['agreement', a.id, 'quote', inAsset.id, outAsset?.id, amount],
    queryFn: () =>
      agreementsApi.quote(a.id, {
        token_in: inAsset.id,
        token_out: outAsset?.id as string,
        amount_in: String(value),
      }),
    enabled: visible && canQuote,
    retry: false,
  });

  const trade = useOnchainAction({
    build: () =>
      agreementsApi.buildTradeTx(a.id, {
        token_in: inAsset.id,
        token_out: outAsset?.id as string,
        amount_in: String(value),
      }),
    invalidate: [['agreement', a.id], ['dashboard'], ['agreements']],
    onSuccess: (res) => {
      if (res.ok) onDone();
    },
  });

  const q = quote.data;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Open a trade"
      subtitle="Swaps inside the escrow. The capital never leaves the contract."
      /*
        Düz düğme, kaydırmalı onay değil. Kaydırma geri dönüşsüz kasa
        hareketleri için var; takas parayı kasadan çıkarmıyor, maks. kayıp
        tabanıyla zaten sınırlı ve kotasyon zamana duyarlı — araya fazladan
        bir hareket koymak kotasyonu eskitmekten başka bir şey yapmıyor.
      */
      footer={
        <>
          <Button
            title="Trade"
            fullWidth
            loading={trade.busy}
            disabled={!q?.allowed}
            onPress={trade.run}
          />
          <Text variant="caption" color="text3">
            Your wallet signs this transaction; your secret key never leaves the device.
          </Text>
        </>
      }
    >
      <View style={styles.tradeSheet}>
        <View style={styles.tradeGroup}>
          <Text variant="captionStrong" color="text2">
            Sell
          </Text>
          <View style={styles.tradeChips}>
            {holdings.map((b) => (
              <Chip
                key={b.asset.id}
                label={assetLabel(b.asset, holdings.map((h) => h.asset))}
                active={inAsset.id === b.asset.id}
                onPress={() => setTokenIn(b.asset.id)}
              />
            ))}
          </View>
          <Text variant="caption" color="text3">
            In escrow: {formatAmount(inBalance, inAsset.code)}
          </Text>
        </View>

        <View style={styles.tradeGroup}>
          <Text variant="captionStrong" color="text2">
            Buy
          </Text>
          <View style={styles.tradeChips}>
            {outOptions.map((x) => (
              <Chip
                key={x.id}
                label={assetLabel(x, outOptions)}
                active={outAsset?.id === x.id}
                onPress={() => setTokenOut(x.id)}
              />
            ))}
          </View>
        </View>

        <Field
          label="Amount"
          value={amount}
          onChangeText={setAmount}
          placeholder={inBalance}
          keyboardType="decimal-pad"
          suffix={inAsset.code}
          error={
            value !== null && value > Number(inBalance)
              ? `The escrow holds ${formatAmount(inBalance, inAsset.code)}.`
              : undefined
          }
        />
        <Button title="Use the whole balance" variant="ghost" size="sm" onPress={() => setAmount(inBalance)} />

        {quote.isFetching ? (
          <Text variant="caption" color="text2">
            Getting a quote…
          </Text>
        ) : null}
        {quote.isError ? <ErrorNotice title="No quote" error={quote.error} /> : null}

        {q ? (
          <Card style={styles.quoteCard}>
            <Row label="You get" value={`${formatAmount(q.amount_out, q.token_out.code)}`} />
            <Row label="At worst" value={`${formatAmount(q.min_out, q.token_out.code)}`} />
            <Row label="Price" value={`1 ${q.token_in.code} = ${q.price} ${q.token_out.code}`} />
            {q.price_impact_pct ? <Row label="Price impact" value={`${q.price_impact_pct}%`} /> : null}
            <Row
              label="Max-loss headroom"
              value={formatAmount(q.headroom, a.base_asset.code)}
            />
            {!q.allowed ? (
              <Text variant="caption" color="loss">
                {q.reason ?? 'The contract would reject this trade.'}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {trade.error ? <ErrorNotice title="Trade failed" error={trade.error} /> : null}
        {trade.busy ? (
          <Text variant="caption" color="text2">
            {phaseLabel(trade.phase)}
          </Text>
        ) : null}

      </View>
    </BottomSheet>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.quoteRow}>
      <Text variant="caption" color="text2">
        {label}
      </Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

function TxLinks({ agreement: a }: { agreement: AgreementOut }) {
  const links: { label: string; hash: string }[] = [];
  if (a.created_tx) links.push({ label: 'Created', hash: a.created_tx });
  if (a.activate_tx) links.push({ label: 'Activated', hash: a.activate_tx });
  if (a.settle_tx) links.push({ label: 'Settled', hash: a.settle_tx });
  if (a.cancel_tx) links.push({ label: 'Cancelled', hash: a.cancel_tx });
  if (links.length === 0) return null;
  return (
    <Card style={styles.list}>
      {links.map((l) => (
        <ListRow
          key={l.hash}
          title={l.label}
          subtitle={`${l.hash.slice(0, 12)}…`}
          trailing={<ExternalLink size={16} color={colors.text3} />}
          onPress={() => void Linking.openURL(explorerTxUrl(l.hash))}
        />
      ))}
    </Card>
  );
}

function TradeRow({ trade }: { trade: TradeOut }) {
  return (
    <ListRow
      title={trade.symbol_label ?? `${trade.token_in.code} → ${trade.token_out.code}`}
      subtitle={trade.note ?? formatRelative(trade.created_at)}
      value={`${trade.amount_in} → ${trade.amount_out}`}
      meta={trade.value_after ? `Value ${trade.value_after}` : undefined}
      trailing={
        trade.tx_hash ? <ExternalLink size={16} color={colors.text3} /> : undefined
      }
      onPress={
        trade.tx_hash ? () => void Linking.openURL(explorerTxUrl(trade.tx_hash as string)) : undefined
      }
    />
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.figure}>
      <Text variant="caption" color="text2">
        {label}
      </Text>
      <Text variant="numericSm">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  header: { gap: spacing.sm },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  kpis: { flexDirection: 'row', gap: spacing.sm },
  kpi: { flex: 1 },
  timeline: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.xs },
  timelineStep: { alignItems: 'center', gap: 4, flex: 1 },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.borderStrong,
  },
  timelineDotDone: { backgroundColor: colors.navy900 },
  timelineDotNow: { width: 14, height: 14, backgroundColor: colors.profit },
  timelineEnded: { alignItems: 'center' },
  chart: { gap: spacing.sm },
  list: { paddingVertical: 0 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  try: { gap: spacing.sm, backgroundColor: colors.surfaceAlt },
  tryHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  figure: { gap: 2 },
  pending: { gap: spacing.sm, backgroundColor: colors.amberBg },
  actions: { gap: spacing.md },
  tradeSheet: { gap: spacing.md, width: '100%' },
  tradeGroup: { gap: spacing.sm },
  tradeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quoteCard: { gap: spacing.xs, width: '100%' },
  quoteRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actionChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  errorBox: { gap: 2, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
