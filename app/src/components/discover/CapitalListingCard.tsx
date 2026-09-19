import { StyleSheet, View } from 'react-native';

import { Avatar, Card, Pill, RiskBadge, Stat, Text } from '@/components/ui';
import { formatRateRange, formatTRY } from '@/lib/format';
import { shortAddress } from '@/lib/stellar';
import { spacing } from '@/theme';
import type { Listing } from '@/types';

/**
 * Figma 2b/2d · Keşfet · Trader (node 21:160) — müşterinin sermaye ilanı kartı.
 * Veri `GET /listings?kind=capital` yanıtından gelir; eksik alanlar çizilmez.
 */
export function CapitalListingCard({ listing }: { listing: Listing }) {
  const owner = listing.owner;
  const name = owner?.username ?? shortAddress(listing.ownerAddress, 6, 6);
  const initials = owner?.avatarInitials ?? name.slice(0, 2).toUpperCase();

  return (
    <Card raised style={styles.card}>
      <View style={styles.header}>
        <Avatar initials={initials} size="lg" />
        <View style={styles.headerText}>
          <Text variant="h2" numberOfLines={2}>
            {listing.title}
          </Text>
          <Text variant="caption" color="text3" numberOfLines={1}>
            {name}
          </Text>
        </View>
        <RiskBadge level={listing.riskLevel} />
      </View>

      <View style={styles.pills}>
        <Pill label={listing.market} tone="navy" />
        <Pill label={`${listing.durationMonths} ay`} />
        {listing.stats?.offers !== undefined ? (
          <Pill label={`${listing.stats.offers} teklif`} />
        ) : null}
      </View>

      {listing.capitalTRY !== undefined ? (
        <View style={styles.capital}>
          <Text variant="caption" color="text2">
            Sermaye
          </Text>
          <Text variant="numeric">{formatTRY(listing.capitalTRY)}</Text>
        </View>
      ) : null}

      <View style={styles.stats}>
        {listing.expectedCommissionRange ? (
          <Stat
            label="Beklenen Komisyon"
            value={formatRateRange(listing.expectedCommissionRange)}
          />
        ) : null}
        {listing.maxLossPct !== undefined ? (
          <Stat label="Maks. Kayıp" value={`%${listing.maxLossPct}`} />
        ) : null}
        {listing.stats?.interest !== undefined ? (
          <Stat label="İlgi" value={String(listing.stats.interest)} />
        ) : null}
      </View>

      {listing.description ? (
        <Text variant="body" color="text2" numberOfLines={3}>
          {listing.description}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md, minHeight: 380, justifyContent: 'flex-start' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerText: { flex: 1, gap: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  capital: { gap: 2 },
  stats: { flexDirection: 'row', gap: spacing.md },
});
