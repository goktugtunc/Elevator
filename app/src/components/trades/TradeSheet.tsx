import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { MarketChart } from '@/components/market';
import {
  BottomSheet,
  Button,
  Card,
  Chip,
  ErrorNotice,
  Field,
  Switch,
  Text,
} from '@/components/ui';
import { agreementsApi, metaApi } from '@/lib/api';
import type { AgreementOut, AssetOut } from '@/lib/api/types';
import { assetLabel, formatAmount, formatAmountExact, parseNumberInput } from '@/lib/format';
import { phaseLabel, useOnchainAction } from '@/lib/onchain';
import { spacing } from '@/theme';

/**
 * Figma "Yeni İşlem" sheet (node 23:181) — işlem açma paneli.
 *
 * Trader parayı çekemez, yalnızca kasanın içinde izinli router üzerinden takas
 * eder. Kontrat, işlem sonrası portföy değeri maks. kayıp tabanının altına
 * düşecekse takası reddeder; bu yüzden imzadan önce sunucudan kotasyon alınır
 * ve `allowed` / `reason` olduğu gibi gösterilir — kullanıcı reddedilecek bir
 * işlemi imzalamaya çalışıp ücret ödemesin.
 *
 * Hem İşlemler sekmesi hem sözleşme ekranı bunu kullanır: iki ayrı panel
 * varken biri varlık kimliği gönderiyor öbürü kod gönderiyordu ve kotasyon
 * kartları birbirini tutmuyordu.
 */
export function TradeSheet({
  agreement: a,
  visible,
  onClose,
  onDone,
}: {
  agreement: AgreementOut;
  visible: boolean;
  onClose: () => void;
  /** Takas zincire yazıldıktan sonra — çağıran ekran kendi görünümünü tazeler. */
  onDone: () => void;
}) {
  // Varlıklar **kimlikle** tutulur, koduyla değil: testnet'te iki ayrı USDC var
  // ve sunucu kod gönderilince `ambiguous_token` ile reddediyor.
  const router = useRouter();
  const [tokenIn, setTokenIn] = useState<string | null>(null);
  const [tokenOut, setTokenOut] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);

  const assets = useQuery({
    queryKey: ['assets', 'all'],
    queryFn: () => metaApi.assets(),
    enabled: visible,
  });

  /** Kasada bakiyesi olan varlıklar — satılabilecek olanlar. */
  const holdings = (a.balances ?? []).filter((b) => Number(b.balance) > 0);
  const inAsset =
    holdings.find((b) => b.asset.id === tokenIn)?.asset ?? holdings[0]?.asset ?? a.base_asset;
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
        note: note.trim() || null,
        notify_investors: notify,
      }),
    invalidate: [['agreement', a.id], ['dashboard'], ['agreements'], ['activity']],
    onSuccess: (res) => {
      if (res.ok) {
        setAmount('');
        setNote('');
        onDone();
      }
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
        {/*
          Karar noktası burası: trader takas tutarını yazmadan önce piyasaya
          baksın diye grafik formun üstünde duruyor.
        */}
        <MarketChart height={150} onExpand={(range) => router.push(`/market?range=${range}`)} />

        <View style={styles.tradeGroup}>
          <Text variant="captionStrong" color="text2">
            Sell
          </Text>
          <View style={styles.tradeChips}>
            {holdings.map((b) => (
              <Chip
                key={b.asset.id}
                label={assetLabel(
                  b.asset,
                  holdings.map((h) => h.asset),
                )}
                active={inAsset.id === b.asset.id}
                onPress={() => setTokenIn(b.asset.id)}
              />
            ))}
          </View>
          <Text variant="caption" color="text3">
            In escrow: {formatAmountExact(inBalance, inAsset.code)}
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
              ? `The escrow holds ${formatAmountExact(inBalance, inAsset.code)}.`
              : undefined
          }
        />
        <Button
          title="Use the whole balance"
          variant="ghost"
          size="sm"
          onPress={() => setAmount(inBalance)}
        />

        {quote.isFetching ? (
          <Text variant="caption" color="text2">
            Getting a quote…
          </Text>
        ) : null}
        {quote.isError ? <ErrorNotice title="No quote" error={quote.error} /> : null}

        {q ? (
          <Card style={styles.quoteCard}>
            <Row label="You get" value={formatAmountExact(q.amount_out, q.token_out.code)} />
            <Row label="At worst" value={formatAmountExact(q.min_out, q.token_out.code)} />
            <Row label="Price" value={`1 ${q.token_in.code} = ${q.price} ${q.token_out.code}`} />
            {q.price_impact_pct ? (
              <Row label="Price impact" value={`${q.price_impact_pct}%`} />
            ) : null}
            <Row label="Max-loss headroom" value={formatAmount(q.headroom, a.base_asset.code)} />
            {!q.allowed ? (
              <Text variant="caption" color="loss">
                {q.reason ?? 'The contract would reject this trade.'}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {/* Not, işlem satırının alt başlığı olarak müşteriye görünür. */}
        <Field
          label="Note"
          value={note}
          onChangeText={setNote}
          placeholder="Why this trade? The capital owner reads this."
          multiline
          maxLength={280}
        />

        <Switch
          value={notify}
          onValueChange={setNotify}
          label="Notify the capital owner"
          hint="Sends a push notification when the trade lands on-chain."
        />

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

const styles = StyleSheet.create({
  tradeSheet: { gap: spacing.md, width: '100%' },
  tradeGroup: { gap: spacing.sm },
  tradeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quoteCard: { gap: spacing.xs, width: '100%' },
  quoteRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
