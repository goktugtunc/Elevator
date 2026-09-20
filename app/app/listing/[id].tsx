import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { Button, Card, ErrorNotice, ListRow, Pill, RiskBadge, Segmented, Text } from '@/components/ui';
import { listingsApi, offersApi } from '@/lib/api';
import type { ListingDetailOut, OfferOut, OfferStatus } from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { formatAmount, formatBps, formatDuration, formatRelative } from '@/lib/format';
import { phaseLabel, useOnchainAction } from '@/lib/onchain';
import { isPast, useNow } from '@/lib/useNow';
import { useSession } from '@/store/session';
import { colors, spacing } from '@/theme';

type Tab = 'offers' | 'details';

/**
 * Figma 6c/6d · İlan Detayı (node 26:345 · 26:462) — `GET /listings/{id}`.
 * Sahibi gelen teklifleri buradan kabul/ret eder; kabul taslak sözleşmeyi doğurur
 * ve kullanıcı zincir üstü adımı tamamlamak için sözleşme ekranına gider.
 */
export default function ListingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const role = useSession((s) => s.role);
  const [tab, setTab] = useState<Tab>('offers');

  const listing = useQuery({
    queryKey: ['listing', id],
    queryFn: () => listingsApi.byId(id),
    enabled: Boolean(id),
  });

  const offers = useQuery({
    queryKey: ['offers', 'listing', id],
    queryFn: () => offersApi.list({ listing_id: id, limit: 50 }),
    enabled: Boolean(id),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['listing', id] });
    void qc.invalidateQueries({ queryKey: ['offers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

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
  const withdraw = useMutation({
    mutationFn: (offerId: string) => offersApi.withdraw(offerId),
    onSuccess: refresh,
  });

  /** Yarıda kalmış yatırmayı tamamlar: taslak ilan ancak böyle yayına çıkar. */
  const deposit = useOnchainAction({
    build: () => listingsApi.reserveTx(id),
    invalidate: [['listing', id], ['listings'], ['dashboard'], ['wallet']],
  });

  /** Kilitli kalan sermayeyi cüzdana geri çeker (ilan kapatılmadan önce şart). */
  const release = useOnchainAction({
    build: () => listingsApi.releaseTx(id),
    invalidate: [['listing', id], ['listings'], ['dashboard'], ['wallet']],
  });

  return (
    <Screen padded={false}>
      <TopBar title="Listing" />
      <View style={styles.body}>
        <AsyncBoundary query={listing}>
          {(l) => (
            <>
              <Header listing={l} />

              {l.is_owner && l.kind === 'capital' ? (
                <EscrowCard listing={l} deposit={deposit} release={release} />
              ) : null}

              <Segmented
                options={[
                  {
                    value: 'offers' as Tab,
                    label: l.offer_count ? `Offers (${l.offer_count})` : 'Offers',
                  },
                  { value: 'details' as Tab, label: 'Details' },
                ]}
                value={tab}
                onChange={setTab}
              />

              {accept.isError || reject.isError || withdraw.isError ? (
                <Text variant="caption" color="loss">
                  {userMessage(accept.error ?? reject.error ?? withdraw.error)}
                </Text>
              ) : null}

              {tab === 'details' ? (
                <Details listing={l} />
              ) : (
                <AsyncBoundary
                  query={offers}
                  isEmpty={(page) => page.items.length === 0}
                  empty={
                    <EmptyState
                      title="No offers yet"
                      body={
                        l.is_owner
                          ? 'Offers on this listing will appear here.'
                          : 'Be the first to send an offer from the Elevator.'
                      }
                    />
                  }
                >
                  {(page) => (
                    <Card style={styles.list}>
                      {page.items.map((offer) => (
                        <OfferRow
                          key={offer.id}
                          offer={offer}
                          isOwner={Boolean(l.is_owner)}
                          busy={
                            (accept.isPending && accept.variables === offer.id) ||
                            (reject.isPending && reject.variables === offer.id) ||
                            (withdraw.isPending && withdraw.variables === offer.id)
                          }
                          onAccept={() => accept.mutate(offer.id)}
                          onReject={() => reject.mutate(offer.id)}
                          onWithdraw={() => withdraw.mutate(offer.id)}
                          onOpenAgreement={(agreementId) =>
                            router.push(`/contract/${agreementId}`)
                          }
                        />
                      ))}
                    </Card>
                  )}
                </AsyncBoundary>
              )}

              {!l.is_owner && role ? (
                <Button
                  title="Message the owner"
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

function Header({ listing }: { listing: ListingDetailOut }) {
  const assetCode = listing.base_asset?.code ?? '';
  const isService = listing.kind === 'service';
  return (
    <Card style={styles.header}>
      <View style={styles.headerTop}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="h1">{listing.title}</Text>
          <Text variant="caption" color="text3">
            {isService ? 'Service listing' : 'Capital listing'} · @{listing.owner.username} ·{' '}
            {formatRelative(listing.created_at)}
          </Text>
        </View>
        <RiskBadge level={listing.risk_profile} />
      </View>
      <View style={styles.pills}>
        <Pill label={listing.status} tone={listing.status === 'active' ? 'navy' : undefined} />
        {(listing.markets ?? []).map((m) => (
          <Pill key={m} label={m} />
        ))}
        {listing.duration_days ? <Pill label={formatDuration(listing.duration_days)} /> : null}
      </View>
      {listing.description ? (
        <Text variant="body" color="text2">
          {listing.description}
        </Text>
      ) : null}
      <View style={styles.headline}>
        {listing.amount ? (
          <Figure label="Capital" value={formatAmount(listing.amount, assetCode)} />
        ) : null}
        {listing.min_capital ? (
          <Figure label="Min. capital" value={formatAmount(listing.min_capital, assetCode)} />
        ) : null}
        {listing.commission_bps != null ? (
          <Figure label="Commission" value={formatBps(listing.commission_bps)} />
        ) : null}
        {listing.max_loss_bps != null ? (
          <Figure label="Max loss" value={formatBps(listing.max_loss_bps)} />
        ) : null}
      </View>
    </Card>
  );
}

/**
 * Sermaye ilanının parası nerede: kasada mı, ne kadarı hâlâ serbest.
 *
 * Sermaye ilan yayınlanırken kasaya yatırılır; kiralanan trader parayı oradan
 * kullanır, cüzdana hiç dokunamaz. Kullanılmayan kısım her an geri çekilebilir.
 */
function EscrowCard({
  listing,
  deposit,
  release,
}: {
  listing: ListingDetailOut;
  deposit: ReturnType<typeof useOnchainAction>;
  release: ReturnType<typeof useOnchainAction>;
}) {
  const code = listing.base_asset?.code ?? '';
  const locked = listing.reserved_amount ?? '0';
  const isDraft = listing.status === 'draft';
  const hasLocked = Number(locked) > 0;
  const busy = deposit.busy || release.busy;

  return (
    <Card style={styles.escrow}>
      <Text variant="captionStrong" color="text2">
        {isDraft ? 'Not published yet' : 'In escrow'}
      </Text>
      {isDraft ? (
        <Text variant="body" color="text2">
          This listing goes live once you move {formatAmount(listing.amount ?? '0', code)} into the
          escrow. Nobody sees it until then.
        </Text>
      ) : (
        <>
          <Text variant="numeric">{formatAmount(locked, code)}</Text>
          <Text variant="caption" color="text3">
            Locked for this listing. A trader you hire trades it inside the escrow and can never
            withdraw it; whatever is not committed to an agreement is yours to take back.
          </Text>
        </>
      )}

      {deposit.error ? <ErrorNotice title="Deposit failed" error={deposit.error} /> : null}
      {release.error ? <ErrorNotice title="Withdrawal failed" error={release.error} /> : null}
      {busy ? (
        <Text variant="caption" color="text2">
          {phaseLabel(deposit.busy ? deposit.phase : release.phase)}
        </Text>
      ) : null}

      <View style={styles.escrowActions}>
        {isDraft ? (
          <Button title="Deposit & publish" loading={deposit.busy} onPress={deposit.run} />
        ) : hasLocked ? (
          <Button
            title="Withdraw"
            variant="secondary"
            loading={release.busy}
            onPress={release.run}
          />
        ) : null}
      </View>
    </Card>
  );
}

function Details({ listing }: { listing: ListingDetailOut }) {
  const assetCode = listing.base_asset?.code ?? '';
  const rows: { label: string; value: string }[] = [
    { label: 'Owner', value: `${listing.owner.display_name} (@${listing.owner.username})` },
    { label: 'Status', value: listing.status },
    { label: 'Base asset', value: assetCode || '—' },
    ...(listing.kind === 'capital'
      ? [
          {
            label: 'In escrow',
            value: listing.reserved_amount
              ? formatAmount(listing.reserved_amount, assetCode)
              : 'Nothing locked',
          },
        ]
      : []),
    { label: 'Duration', value: formatDuration(listing.duration_days) },
    { label: 'Views', value: String(listing.view_count ?? 0) },
    { label: 'Likes', value: String(listing.like_count ?? 0) },
    { label: 'Offers', value: String(listing.offer_count ?? 0) },
    { label: 'Created', value: formatRelative(listing.created_at) },
  ];
  if (listing.expected_return_min_bps != null && listing.expected_return_max_bps != null) {
    rows.splice(4, 0, {
      label: 'Expected return',
      value: `${formatBps(listing.expected_return_min_bps)} – ${formatBps(listing.expected_return_max_bps)}`,
    });
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

const STATUS_TEXT: Record<OfferStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Declined',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

function OfferRow({
  offer,
  isOwner,
  busy,
  onAccept,
  onReject,
  onWithdraw,
  onOpenAgreement,
}: {
  offer: OfferOut;
  isOwner: boolean;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onWithdraw: () => void;
  onOpenAgreement: (agreementId: string) => void;
}) {
  const now = useNow();
  const incoming = offer.is_incoming ?? isOwner;
  const pending = offer.status === 'pending';
  const expired = isPast(offer.expires_at, now);
  const party = incoming ? offer.from_user : offer.to_user;
  return (
    <View style={styles.offer}>
      <ListRow
        title={party.display_name}
        subtitle={`${offer.duration_days} days · ${formatBps(offer.commission_bps)} commission`}
        initials={party.display_name}
        value={formatAmount(offer.amount, offer.base_asset.code)}
        meta={
          pending && !expired
            ? `Expires ${formatRelative(offer.expires_at)}`
            : STATUS_TEXT[offer.status]
        }
      />
      {offer.note ? (
        <Text variant="caption" color="text2" style={styles.note}>
          “{offer.note}”
        </Text>
      ) : null}
      <View style={styles.offerActions}>
        {offer.agreement_id ? (
          <Button
            title="Open agreement"
            variant="secondary"
            size="sm"
            onPress={() => onOpenAgreement(offer.agreement_id as string)}
          />
        ) : null}
        <View style={{ flex: 1 }} />
        {pending && !expired && incoming ? (
          <>
            <Button title="Decline" variant="ghost" size="sm" loading={busy} onPress={onReject} />
            <Button title="Accept" size="sm" loading={busy} onPress={onAccept} />
          </>
        ) : null}
        {pending && !expired && !incoming ? (
          <Button title="Withdraw" variant="ghost" size="sm" loading={busy} onPress={onWithdraw} />
        ) : null}
      </View>
    </View>
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
  escrow: { gap: spacing.sm },
  escrowActions: { flexDirection: 'row', gap: spacing.sm },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  header: { gap: spacing.sm },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  headline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  figure: { gap: 2 },
  list: { paddingVertical: 0 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  offer: { gap: spacing.xs, paddingBottom: spacing.sm },
  note: { fontStyle: 'italic' },
  offerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
