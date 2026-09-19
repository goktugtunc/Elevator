import { Star } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Avatar, Card, Pill, RiskBadge, Sparkline, Stat, Text } from '@/components/ui';
import { formatPnlPct, formatRatePct, formatTRY } from '@/lib/format';
import { shortAddress } from '@/lib/stellar';
import { colors, pnlColor, spacing } from '@/theme';
import type { Listing } from '@/types';

/**
 * Figma 2a/2c · Keşfet · Müşteri (node 21:30) — trader'ın hizmet ilanı kartı.
 * Veri `GET /listings?kind=service` yanıtından gelir; eksik alanlar çizilmez
 * (sahte değer yok, bkz. SPRINT-1.md "Sahte veri yasağı").
 */
export function ServiceListingCard({ listing }: { listing: Listing }) {
  const owner = listing.owner;
  const title = owner?.username ?? shortAddress(listing.ownerAddress, 6, 6);
  const initials = owner?.avatarInitials ?? title.slice(0, 2).toUpperCase();
  const sparkline = owner?.sparkline;

  return (
    <Card raised style={styles.card}>
      <View style={styles.header}>
        <Avatar initials={initials} size="lg" />
        <View style={styles.headerText}>
          <Text variant="h2" numberOfLines={1}>
            {title}
          </Text>
          {owner?.handle ? (
            <Text variant="caption" color="text3" numberOfLines={1}>
              {owner.handle}
            </Text>
          ) : null}
          {owner?.rating !== undefined ? (
            <View style={styles.rating}>
              <Star size={13} color={colors.amber} fill={colors.amber} />
              <Text variant="captionStrong">{owner.rating.toFixed(1).replace('.', ',')}</Text>
              {owner.ratingCount !== undefined ? (
                <Text variant="caption" color="text3">
                  ({owner.ratingCount})
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        <RiskBadge level={listing.riskLevel} />
      </View>

      <View style={styles.pills}>
        <Pill label={listing.market} tone="navy" />
        <Pill label={`${listing.durationMonths} ay`} />
        {owner?.activeInvestors !== undefined ? (
          <Pill label={`${owner.activeInvestors} yatırımcı`} />
        ) : null}
      </View>

      {owner?.return12mPct !== undefined ? (
        <View style={styles.performance}>
          <View>
            <Text variant="caption" color="text2">
              12 Ay Getiri
            </Text>
            <Text variant="numeric" color={pnlColor(owner.return12mPct)}>
              {formatPnlPct(owner.return12mPct)}
            </Text>
          </View>
          {sparkline && sparkline.length > 1 ? (
            <Sparkline data={sparkline} height={44} style={styles.spark} />
          ) : null}
        </View>
      ) : null}

      <View style={styles.stats}>
        {owner?.maxDrawdownPct !== undefined ? (
          <Stat
            label="Maks. Drawdown"
            value={formatPnlPct(owner.maxDrawdownPct)}
            signed={owner.maxDrawdownPct}
          />
        ) : null}
        {listing.commissionPct !== undefined ? (
          <Stat label="Komisyon" value={formatRatePct(listing.commissionPct)} />
        ) : null}
        {listing.minCapitalTRY !== undefined ? (
          <Stat label="Min. Sermaye" value={formatTRY(listing.minCapitalTRY)} />
        ) : null}
      </View>

      {listing.description ? (
        <Text variant="body" color="text2" numberOfLines={3}>
          {listing.description}
        </Text>
      ) : null}

      {owner?.tags?.length ? (
        <View style={styles.pills}>
          {owner.tags.map((tag) => (
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
  performance: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  spark: { flex: 1 },
  stats: { flexDirection: 'row', gap: spacing.md },
});
