import { Star } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Avatar, Card, Pill, RiskBadge, Stat, Text } from '@/components/ui';
import type { DiscoverCardOut } from '@/lib/api/types';
import { formatAmount, formatBps, formatBpsSigned, formatDuration } from '@/lib/format';
import { shortAddress } from '@/lib/stellar';
import { colors, pnlColor, spacing } from '@/theme';

/**
 * Keşfet kartı — `GET /api/v1/discover` yanıtındaki `DiscoverCardOut`.
 * Aynı bileşen iki rolü de karşılar: sunucu müşteriye hizmet ilanlarını,
 * trader'a sermaye ilanlarını döndürür (`kind`). Eksik alanlar çizilmez.
 */
const MARKET_LABEL: Record<string, string> = {
  crypto: 'Crypto',
  stable_fx: 'Stable / FX',
  defi: 'DeFi',
};

export function ListingCard({ card }: { card: DiscoverCardOut }) {
  const { listing } = card;
  const owner = listing.owner;
  const stats = owner?.stats ?? null;
  const isService = listing.kind === 'service';
  const assetCode = listing.base_asset?.code ?? '';

  const name = owner?.display_name || owner?.username || shortAddress(listing.owner_id, 4, 4);
  const initials = (owner?.username ?? name).slice(0, 2).toUpperCase();
  const rating = stats?.rating_avg ? Number(stats.rating_avg) : null;

  return (
    <Card raised style={styles.card}>
      <View style={styles.header}>
        <Avatar initials={initials} size="lg" />
        <View style={styles.headerText}>
          <Text variant="h2" numberOfLines={1}>
            {isService ? name : listing.title}
          </Text>
          <Text variant="caption" color="text3" numberOfLines={1}>
            {isService ? `@${owner?.username ?? '—'}` : name}
          </Text>
          {rating !== null && rating > 0 ? (
            <View style={styles.rating}>
              <Star size={13} color={colors.amber} fill={colors.amber} />
              <Text variant="captionStrong">{rating.toFixed(1)}</Text>
              <Text variant="caption" color="text3">
                ({stats?.rating_count ?? 0})
              </Text>
            </View>
          ) : null}
        </View>
        <RiskBadge level={listing.risk_profile ?? owner?.risk_level} />
      </View>

      <View style={styles.pills}>
        {(listing.markets ?? []).map((m) => (
          <Pill key={m} label={MARKET_LABEL[m] ?? m} tone="navy" />
        ))}
        {listing.duration_days ? <Pill label={formatDuration(listing.duration_days)} /> : null}
        {stats?.active_agreements ? <Pill label={`${stats.active_agreements} active`} /> : null}
      </View>

      {isService && stats ? (
        <View style={styles.performance}>
          <View style={{ flex: 1 }}>
            <Text variant="caption" color="text2">
              Total return
            </Text>
            <Text variant="numeric" color={pnlColor(stats.total_return_bps ?? 0)}>
              {formatBpsSigned(stats.total_return_bps ?? 0)}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="caption" color="text2">
              Managed capital
            </Text>
            <Text variant="numericSm">{formatAmount(stats.managed_capital, assetCode)}</Text>
          </View>
        </View>
      ) : null}

      {!isService && listing.amount ? (
        <View style={styles.capital}>
          <Text variant="caption" color="text2">
            Capital
          </Text>
          <Text variant="numeric">{formatAmount(listing.amount, assetCode)}</Text>
        </View>
      ) : null}

      <View style={styles.stats}>
        {isService ? (
          <>
            {stats?.max_drawdown_bps != null ? (
              <Stat
                label="Max drawdown"
                value={formatBpsSigned(-Math.abs(stats.max_drawdown_bps))}
                signed={-Math.abs(stats.max_drawdown_bps)}
              />
            ) : null}
            {listing.commission_bps != null ? (
              <Stat label="Commission" value={formatBps(listing.commission_bps)} />
            ) : null}
            {listing.min_capital ? (
              <Stat label="Min. capital" value={formatAmount(listing.min_capital, assetCode)} />
            ) : null}
          </>
        ) : (
          <>
            {listing.expected_return_min_bps !== null ? (
              <Stat
                label="Expected return"
                value={`${formatBps(listing.expected_return_min_bps)} – ${formatBps(listing.expected_return_max_bps)}`}
              />
            ) : null}
            {listing.max_loss_bps !== null ? (
              <Stat label="Max loss" value={formatBps(listing.max_loss_bps)} />
            ) : null}
            <Stat label="Offers" value={String(listing.offer_count)} />
          </>
        )}
      </View>

      {listing.description ? (
        <Text variant="body" color="text2" numberOfLines={3}>
          {listing.description}
        </Text>
      ) : null}

      {card.tags?.length ? (
        <View style={styles.pills}>
          {card.tags.map((tag) => (
            <Pill key={tag} label={tag} tone="amber" />
          ))}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md, minHeight: 380, justifyContent: 'flex-start' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerText: { flex: 1, gap: 2 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  performance: { flexDirection: 'row', gap: spacing.lg },
  capital: { gap: 2 },
  stats: { flexDirection: 'row', gap: spacing.md },
});
