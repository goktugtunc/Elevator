import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { Copy, ExternalLink } from 'lucide-react-native';
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
  ListRow,
  Pill,
  Segmented,
  Text,
} from '@/components/ui';
import { anchorApi, walletApi } from '@/lib/api';
import type {
  AnchorTransactionOut,
  MissingTrustlineOut,
  MovementOut,
  WalletBalanceOut,
} from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { formatRelative, parseNumberInput } from '@/lib/format';
import { phaseLabel, useOnchainAction } from '@/lib/onchain';
import { explorerAccountUrl, explorerTxUrl, shortAddress } from '@/lib/stellar';
import { useSession } from '@/store/session';
import { colors, pnlColor, radius, spacing } from '@/theme';

type Tab = 'balances' | 'movements' | 'transfers';
type Kind = 'deposit' | 'withdraw';

/**
 * Figma 8c · Cüzdan (node 27:699) — `GET /wallet`, `/wallet/deposit-info`,
 * `/anchor/*`.
 *
 * TRY yatırma/çekme SEP-24 interactive akışıyla yürür: sunucu anchor'dan bir
 * URL alır, uygulama onu sistem tarayıcısında açar (asla iframe'de), dönüşte
 * işlem durumu sorgulanır. Çekimde anchor'a yapılacak ödeme yine cüzdanda
 * imzalanır.
 */
export default function Wallet() {
  const qc = useQueryClient();
  const address = useSession((s) => s.address);
  const [tab, setTab] = useState<Tab>('balances');
  const [transferKind, setTransferKind] = useState<Kind | null>(null);
  const [amount, setAmount] = useState('');
  const [assetCode, setAssetCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const wallet = useQuery({
    queryKey: ['wallet'],
    queryFn: () => walletApi.get(20),
  });

  const depositInfo = useQuery({
    queryKey: ['wallet', 'deposit-info'],
    queryFn: walletApi.depositInfo,
    enabled: transferKind === 'deposit',
  });

  const anchorTxs = useQuery({
    queryKey: ['anchor', 'transactions'],
    queryFn: () => anchorApi.transactions({ limit: 30, sync: true }),
    enabled: tab === 'transfers',
  });

  const refreshWallet = () => {
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['anchor'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const transfer = useMutation({
    mutationFn: async () => {
      const value = parseNumberInput(amount);
      const payload = {
        asset_code: assetCode,
        amount: value !== null ? String(value) : undefined,
      };
      return transferKind === 'deposit'
        ? anchorApi.deposit(payload)
        : anchorApi.withdraw(payload);
    },
    onSuccess: async (res) => {
      if (res.interactive_url) {
        await WebBrowser.openBrowserAsync(res.interactive_url);
      }
      setTransferKind(null);
      setAmount('');
      refreshWallet();
      setTab('transfers');
    },
  });

  const fundAccount = useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Friendbot could not fund this account.');
      return true;
    },
    onSuccess: refreshWallet,
  });

  const copyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen padded={false}>
      <TopBar title="Wallet" />
      <View style={styles.body}>
        <AsyncBoundary query={wallet}>
          {(w) => (
            <>
              <Card style={styles.header}>
                <Text variant="caption" color="text2">
                  Total value
                </Text>
                <Text variant="display">{w.total_try ? `₺${w.total_try}` : '—'}</Text>
                <View style={styles.addressRow}>
                  <Text variant="numericSm" color="text2">
                    {shortAddress(w.address, 8, 8)}
                  </Text>
                  <Button
                    title={copied ? 'Copied' : 'Copy'}
                    variant="ghost"
                    size="sm"
                    onPress={copyAddress}
                    leftIcon={<Copy size={14} color={colors.navy900} />}
                  />
                  <View style={{ flex: 1 }} />
                  <Pill label={w.network} tone="navy" />
                </View>
                {w.fx ? (
                  <Text variant="caption" color="text3">
                    1 USD = {w.fx.rate} TRY ({w.fx.source}
                    {w.fx.stale ? ' · stale' : ''})
                  </Text>
                ) : null}

                {!w.funded ? (
                  <View style={styles.notice}>
                    <Text variant="captionStrong">This account is not on the ledger yet</Text>
                    <Text variant="caption" color="text2">
                      Fund it once so it can hold assets.
                    </Text>
                    {w.friendbot_url ? (
                      <Button
                        title="Fund with Friendbot"
                        size="sm"
                        loading={fundAccount.isPending}
                        onPress={() => fundAccount.mutate(w.friendbot_url as string)}
                      />
                    ) : null}
                    {fundAccount.isError ? (
                      <Text variant="caption" color="loss">
                        {userMessage(fundAccount.error)}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {w.anchor_enabled ? (
                  <View style={styles.transferButtons}>
                    <Button
                      title="Deposit TRY"
                      onPress={() => setTransferKind('deposit')}
                      style={styles.transferButton}
                    />
                    <Button
                      title="Withdraw"
                      variant="secondary"
                      onPress={() => setTransferKind('withdraw')}
                      style={styles.transferButton}
                    />
                  </View>
                ) : (
                  <Text variant="caption" color="text3">
                    Deposits and withdrawals are disabled — no anchor is configured.
                  </Text>
                )}
              </Card>

              {w.missing_trustlines?.length ? (
                <TrustlineCard
                  missing={w.missing_trustlines}
                  onDone={refreshWallet}
                />
              ) : null}

              <Segmented
                options={[
                  { value: 'balances' as Tab, label: 'Balances' },
                  { value: 'movements' as Tab, label: 'Movements' },
                  { value: 'transfers' as Tab, label: 'Transfers' },
                ]}
                value={tab}
                onChange={setTab}
              />

              {tab === 'balances' ? (
                w.balances.length ? (
                  <Card style={styles.list}>
                    {w.balances.map((b) => (
                      <BalanceRow key={`${b.code}-${b.issuer ?? b.contract_id ?? ''}`} balance={b} />
                    ))}
                  </Card>
                ) : (
                  <EmptyState title="No balances" body="Deposit TRY to get started." />
                )
              ) : null}

              {tab === 'movements' ? (
                w.movements?.length ? (
                  <Card style={styles.list}>
                    {w.movements.map((m) => (
                      <MovementRow key={m.id} movement={m} />
                    ))}
                  </Card>
                ) : (
                  <EmptyState
                    title="No movements yet"
                    body="Payments, escrow transfers and anchor transfers land here."
                  />
                )
              ) : null}

              {tab === 'transfers' ? (
                <AsyncBoundary
                  query={anchorTxs}
                  isEmpty={(res) => res.items.length === 0}
                  empty={
                    <EmptyState
                      title="No transfers yet"
                      body="Your TRY deposits and withdrawals will be listed here."
                    />
                  }
                >
                  {(res) => (
                    <>
                      {res.sync_error ? (
                        <Text variant="caption" color="loss">
                          Could not reach the anchor: {res.sync_error}
                        </Text>
                      ) : null}
                      <Card style={styles.list}>
                        {res.items.map((t) => (
                          <AnchorTxRow key={t.id} tx={t} onDone={refreshWallet} />
                        ))}
                      </Card>
                    </>
                  )}
                </AsyncBoundary>
              ) : null}

              <Button
                title="View on Stellar Explorer"
                variant="ghost"
                onPress={() => void Linking.openURL(explorerAccountUrl(w.address))}
              />
            </>
          )}
        </AsyncBoundary>
      </View>

      <BottomSheet
        visible={transferKind !== null}
        onClose={() => setTransferKind(null)}
        title={transferKind === 'deposit' ? 'Deposit TRY' : 'Withdraw'}
        subtitle={
          transferKind === 'deposit'
            ? 'The anchor collects your bank details and issues the asset to your wallet.'
            : 'The anchor pays out to your bank account once you send the asset back.'
        }
        footer={
          <Button
            title={transferKind === 'deposit' ? 'Continue to the anchor' : 'Start withdrawal'}
            fullWidth
            loading={transfer.isPending}
            onPress={() => transfer.mutate()}
          />
        }
      >
        <View style={styles.sheet}>
          {transferKind === 'deposit' && depositInfo.data ? (
            <View style={styles.group}>
              <Text variant="captionStrong" color="text2">
                Asset
              </Text>
              <View style={styles.chips}>
                {(depositInfo.data.anchor_assets ?? []).map((a) => (
                  <Chip
                    key={a.code}
                    label={a.display_code}
                    active={assetCode === a.code}
                    onPress={() => setAssetCode(a.code)}
                  />
                ))}
              </View>
              {depositInfo.data.anchor_error ? (
                <Text variant="caption" color="loss">
                  {depositInfo.data.anchor_error}
                </Text>
              ) : null}
            </View>
          ) : null}

          <Field
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            placeholder="Optional — the anchor can ask for it"
            keyboardType="decimal-pad"
          />

          {transfer.isError ? (
            <ErrorNotice title="Transfer could not start" error={transfer.error} />
          ) : null}

          <Text variant="caption" color="text3">
            The anchor screen opens in your browser. Your secret key is never shared with it.
          </Text>
        </View>
      </BottomSheet>
    </Screen>
  );
}

function TrustlineCard({
  missing,
  onDone,
}: {
  missing: MissingTrustlineOut[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState<MissingTrustlineOut | null>(null);
  const tx = useOnchainAction({
    build: () =>
      walletApi.buildTrustlineTx({
        asset_code: target?.asset_code as string,
        issuer: target?.issuer,
      }),
    invalidate: [['wallet']],
    onSuccess: (res) => {
      if (res.ok) {
        setTarget(null);
        onDone();
      }
    },
  });

  return (
    <Card style={styles.trustline}>
      <Text variant="captionStrong">Trustline needed</Text>
      <Text variant="caption" color="text2">
        Stellar requires a trustline before your wallet can hold an issued asset. It is a one-time
        on-chain step.
      </Text>
      <View style={styles.chips}>
        {missing.map((m) => (
          <Chip
            key={m.asset_code}
            label={m.asset_code}
            active={target?.asset_code === m.asset_code}
            onPress={() => {
              tx.reset();
              setTarget(m);
            }}
          />
        ))}
      </View>
      {target ? (
        <>
          <Button
            title={`Add ${target.asset_code} trustline`}
            loading={tx.busy}
            onPress={tx.run}
          />
          {tx.busy ? (
            <Text variant="caption" color="text2">
              {phaseLabel(tx.phase)}
            </Text>
          ) : null}
          {tx.error ? (
            <Text variant="caption" color="loss">
              {tx.error}
            </Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function BalanceRow({ balance: b }: { balance: WalletBalanceOut }) {
  return (
    <ListRow
      title={b.asset?.name ?? b.code}
      subtitle={`${b.code} · ${b.source}${b.is_anchor_asset ? ' · anchor asset' : ''}`}
      trailing={
        <View style={styles.rowRight}>
          <Text variant="numericSm">{b.balance}</Text>
          {b.value_try ? (
            <Text variant="caption" color="text3">
              ₺{b.value_try}
            </Text>
          ) : null}
        </View>
      }
    />
  );
}

function MovementRow({ movement: m }: { movement: MovementOut }) {
  const sign = m.direction === 'in' ? 1 : m.direction === 'out' ? -1 : 0;
  return (
    <ListRow
      title={m.title}
      subtitle={`${m.counterparty ? `${shortAddress(m.counterparty)} · ` : ''}${formatRelative(m.at)}`}
      trailing={
        <View style={styles.rowRight}>
          <Text variant="numericSm" color={pnlColor(sign)}>
            {m.amount ? `${sign > 0 ? '+' : sign < 0 ? '−' : ''}${m.amount} ${m.asset_code}` : '—'}
          </Text>
          {m.value_try ? (
            <Text variant="caption" color="text3">
              ₺{m.value_try}
            </Text>
          ) : null}
        </View>
      }
      onPress={m.tx_hash ? () => void Linking.openURL(explorerTxUrl(m.tx_hash as string)) : undefined}
    />
  );
}

function AnchorTxRow({ tx, onDone }: { tx: AnchorTransactionOut; onDone: () => void }) {
  const payment = useOnchainAction({
    build: () => anchorApi.buildWithdrawPaymentTx(tx.id),
    invalidate: [['wallet'], ['anchor']],
    onSuccess: (res) => {
      if (res.ok) onDone();
    },
  });

  const act = async () => {
    if (tx.action === 'open_interactive' && tx.interactive_url) {
      await WebBrowser.openBrowserAsync(tx.interactive_url);
      onDone();
      return;
    }
    if (tx.action === 'send_payment') payment.run();
  };

  const actionable = tx.action === 'open_interactive' || tx.action === 'send_payment';

  return (
    <View style={styles.anchorTx}>
      <ListRow
        title={`${tx.kind === 'deposit' ? 'Deposit' : 'Withdraw'} · ${tx.asset_code}`}
        subtitle={`${tx.status_label} · ${formatRelative(tx.created_at)}`}
        value={tx.amount_in ?? tx.amount_out ?? undefined}
        meta={tx.amount_fee ? `fee ${tx.amount_fee}` : undefined}
        trailing={
          tx.more_info_url ? <ExternalLink size={16} color={colors.text3} /> : undefined
        }
        onPress={
          tx.more_info_url ? () => void Linking.openURL(tx.more_info_url as string) : undefined
        }
      />
      {tx.message ? (
        <Text variant="caption" color="text2">
          {tx.message}
        </Text>
      ) : null}
      {actionable ? (
        <Button title={tx.action_label} size="sm" loading={payment.busy} onPress={act} />
      ) : null}
      {payment.busy ? (
        <Text variant="caption" color="text2">
          {phaseLabel(payment.phase)}
        </Text>
      ) : null}
      {payment.error ? (
        <Text variant="caption" color="loss">
          {payment.error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  header: { gap: spacing.xs },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  notice: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.amberBg,
    marginTop: spacing.sm,
  },
  transferButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  transferButton: { flex: 1 },
  trustline: { gap: spacing.sm, backgroundColor: colors.amberBg },
  list: { paddingVertical: 0 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  anchorTx: { gap: spacing.xs, paddingBottom: spacing.sm },
  sheet: { gap: spacing.md },
  group: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
