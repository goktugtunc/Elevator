import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, Screen, TopBar } from '@/components/layout';
import { PortfolioCard } from '@/components/profile';
import { Avatar, Button, Card, KpiBox, Pill, RiskBadge, Text } from '@/components/ui';
import { usersApi } from '@/lib/api';
import type { UserOut } from '@/lib/api/types';
import { formatAmount, formatBps, formatRelative } from '@/lib/format';
import { spacing } from '@/theme';

/**
 * Herkesin görebildiği kısa profil — `GET /users/{id}`.
 *
 * Trader profili (`/trader/{id}`) yalnızca trader'lar için var; müşteriye ait
 * bir profil ekranı hiç yoktu, dolayısıyla sohbetten karşı tarafa gidilemiyordu.
 * Bu ekran ikisini de açar ve trader ise zengin profile bir geçiş sunar.
 */
export default function PublicProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const user = useQuery({
    queryKey: ['user', id],
    queryFn: () => usersApi.byId(id),
    enabled: Boolean(id),
  });

  return (
    <Screen>
      <TopBar title="Profile" />
      <AsyncBoundary query={user}>{(u) => <Body user={u} onFullProfile={() => router.push(`/trader/${u.id}`)} />}</AsyncBoundary>
    </Screen>
  );
}

/** "Goktug Tunc" → "GO"; Avatar yalnızca baş harfleri alıyor. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const text = parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] ?? '?').slice(0, 2);
  return text.toUpperCase();
}

function Body({ user: u, onFullProfile }: { user: UserOut; onFullProfile: () => void }) {
  const isTrader = u.role === 'trader';
  return (
    <View style={styles.body}>
      <Card style={styles.header}>
        <Avatar initials={initials(u.display_name)} size="lg" />
        <View style={styles.headerText}>
          <Text variant="h1">{u.display_name}</Text>
          <Text variant="caption" color="text3">
            @{u.username} · {isTrader ? 'Trader' : 'Customer'} · joined {formatRelative(u.created_at)}
          </Text>
        </View>
        <RiskBadge level={u.risk_profile} />
      </Card>

      {u.bio ? (
        <Card>
          <Text variant="body" color="text2">
            {u.bio}
          </Text>
        </Card>
      ) : null}

      {(u.markets ?? []).length > 0 ? (
        <View style={styles.pills}>
          {(u.markets ?? []).map((m) => (
            <Pill key={m} label={m} />
          ))}
        </View>
      ) : null}

      {isTrader ? (
        <>
          <PortfolioCard text={u.portfolio} />
          <View style={styles.grid}>
            <KpiBox
              label="Rating"
              value={u.stats?.rating_avg ? `${u.stats.rating_avg} / 5` : '—'}
              sub={u.stats?.rating_count ? `${u.stats.rating_count} reviews` : 'No reviews yet'}
            />
            <KpiBox
              label="Commission"
              value={u.commission_bps != null ? formatBps(u.commission_bps) : '—'}
              sub={u.min_capital ? `min ${formatAmount(u.min_capital)}` : undefined}
            />
          </View>
          {u.strategy_summary ? (
            <Card style={styles.group}>
              <Text variant="captionStrong" color="text2">
                Strategy
              </Text>
              <Text variant="body" color="text2">
                {u.strategy_summary}
              </Text>
            </Card>
          ) : null}
          <Button title="See the full profile" variant="secondary" onPress={onFullProfile} />
        </>
      ) : (
        <View style={styles.grid}>
          <KpiBox
            label="Budget"
            value={u.budget_amount ? formatAmount(u.budget_amount) : '—'}
            sub="used for matching"
          />
          <KpiBox label="Risk preference" value={u.risk_profile ?? '—'} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerText: { flex: 1, gap: 2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  grid: { flexDirection: 'row', gap: spacing.md },
  group: { gap: spacing.sm },
});
