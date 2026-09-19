import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  BottomSheet,
  Button,
  Chip,
  ErrorNotice,
  Field,
  SlideToConfirm,
  Switch,
  Text,
} from '@/components/ui';
import { agreementsApi, metaApi } from '@/lib/api';
import type { AgreementOut } from '@/lib/api/types';
import { formatAmount, formatBps, parseNumberInput } from '@/lib/format';
import { phaseLabel, useOnchainAction } from '@/lib/onchain';
import { colors, radius, spacing } from '@/theme';

/**
 * Figma "Yeni İşlem" sheet (node 23:181) — `POST /agreements/{id}/tx/trade`.
 *
 * İmzadan önce `GET /agreements/{id}/quote` ile teklif alınır: router fiyatı,
 * tahmini değer ve **drawdown tabanına kalan pay**. Sunucu `allowed: false`
 * derse sebebi gösterilir ve imza adımı açılmaz — zincire boşuna işlem gitmez.
 */
export function NewTradeSheet({
  agreement,
  visible,
  onClose,
}: {
  agreement: AgreementOut;
  visible: boolean;
  onClose: () => void;
}) {
  const [tokenIn, setTokenIn] = useState<string | null>(null);
  const [tokenOut, setTokenOut] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [quoteKey, setQuoteKey] = useState(0);

  const assets = useQuery({ queryKey: ['assets'], queryFn: () => metaApi.assets() });
  const balances = agreement.balances ?? [];
  const amountValue = parseNumberInput(amount);
  const ready = Boolean(tokenIn && tokenOut && amountValue && amountValue > 0);

  const quote = useQuery({
    queryKey: ['agreement', agreement.id, 'quote', tokenIn, tokenOut, amount, quoteKey],
    queryFn: () =>
      agreementsApi.quote(agreement.id, {
        token_in: tokenIn as string,
        token_out: tokenOut as string,
        amount_in: String(amountValue),
      }),
    enabled: visible && ready,
    retry: 0,
  });

  const tx = useOnchainAction({
    build: () =>
      agreementsApi.buildTradeTx(agreement.id, {
        token_in: tokenIn as string,
        token_out: tokenOut as string,
        amount_in: String(amountValue),
        note: note.trim() || null,
        notify_investors: notify,
      }),
    invalidate: [
      ['agreement', agreement.id],
      ['agreement', agreement.id, 'trades'],
      ['activity'],
      ['dashboard'],
    ],
    onSuccess: (res) => {
      if (res.ok) {
        setAmount('');
        setNote('');
        onClose();
      }
    },
  });

  const reset = () => {
    tx.reset();
    setQuoteKey((k) => k + 1);
  };

  const outOptions = (assets.data ?? []).filter((a) => a.id !== tokenIn);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="New trade"
      subtitle={`${agreement.customer.display_name}'s capital · ${agreement.base_asset.code}`}
      footer={
        quote.data?.allowed ? (
          <View style={styles.footer}>
            <SlideToConfirm label="Slide to sign the trade" onConfirm={tx.run} disabled={tx.busy} />
            {tx.busy ? (
              <Text variant="caption" color="text2" align="center">
                {phaseLabel(tx.phase)}
              </Text>
            ) : null}
          </View>
        ) : null
      }
    >
      <View style={styles.body}>
        <Group label="Sell" hint="Only assets the agreement already holds can be sold.">
          {balances.length === 0 ? (
            <Text variant="caption" color="text3">
              This agreement has no balances yet.
            </Text>
          ) : (
            <View style={styles.chips}>
              {balances.map((b) => (
                <Chip
                  key={b.asset.id}
                  label={`${b.asset.code} · ${b.balance}`}
                  active={tokenIn === b.asset.id}
                  onPress={() => {
                    setTokenIn(b.asset.id);
                    reset();
                  }}
                />
              ))}
            </View>
          )}
        </Group>

        <Group label="Buy">
          <View style={styles.chips}>
            {outOptions.map((a) => (
              <Chip
                key={a.id}
                label={a.code}
                active={tokenOut === a.id}
                onPress={() => {
                  setTokenOut(a.id);
                  reset();
                }}
              />
            ))}
          </View>
        </Group>

        <Field
          label="Amount"
          value={amount}
          onChangeText={(v) => {
            setAmount(v);
            reset();
          }}
          placeholder="0"
          keyboardType="decimal-pad"
          hint="Amount of the asset you are selling."
        />

        {quote.isFetching ? (
          <Text variant="caption" color="text2">
            Getting a quote from the router…
          </Text>
        ) : null}

        {quote.isError ? <ErrorNotice title="Could not get a quote" error={quote.error} /> : null}

        {quote.data ? (
          <View style={[styles.quote, !quote.data.allowed && styles.quoteBlocked]}>
            <Row label="You receive" value={`${quote.data.amount_out} ${quote.data.token_out.code}`} />
            <Row label="Minimum out" value={`${quote.data.min_out} ${quote.data.token_out.code}`} />
            <Row label="Price" value={`${quote.data.price} ${quote.data.token_out.code}`} />
            <Row label="Slippage" value={formatBps(quote.data.slippage_bps)} />
            <Row
              label="Value after"
              value={formatAmount(quote.data.value_after_estimate, agreement.base_asset.code)}
            />
            <Row
              label="Drawdown headroom"
              value={`${formatAmount(quote.data.headroom, agreement.base_asset.code)} (${formatBps(quote.data.headroom_bps)})`}
            />
            {quote.data.allowed ? (
              <Text variant="caption" color="text3">
                Quote from {quote.data.source}. The escrow rejects trades that fall below the
                drawdown floor.
              </Text>
            ) : (
              <Text variant="captionStrong" color="loss">
                {quote.data.reason ?? 'This trade would breach the drawdown limit.'}
              </Text>
            )}
          </View>
        ) : null}

        <Field
          label="Note"
          value={note}
          onChangeText={setNote}
          placeholder="Why this trade? Investors can read this."
          multiline
          maxLength={280}
        />

        <Switch
          value={notify}
          onValueChange={setNotify}
          label="Notify my investors"
          hint="Sends a push notification when the trade lands on-chain."
        />

        {tx.error ? <ErrorNotice title="Trade failed" error={tx.error} /> : null}

        {!quote.data?.allowed && ready && !quote.isFetching && !quote.isError ? (
          <Button title="Refresh quote" variant="secondary" onPress={reset} />
        ) : null}
      </View>
    </BottomSheet>
  );
}

function Group({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.group}>
      <Text variant="captionStrong" color="text2">
        {label}
      </Text>
      {children}
      {hint ? (
        <Text variant="caption" color="text3">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text variant="caption" color="text2">
        {label}
      </Text>
      <Text variant="numericSm">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  group: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quote: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  quoteBlocked: { backgroundColor: colors.redBg },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  errorBox: { gap: 2, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
  footer: { gap: spacing.sm },
});
