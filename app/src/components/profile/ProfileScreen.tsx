import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  Bell,
  ChevronRight,
  FileText,
  Pencil,
  HelpCircle,
  LineChart,
  ShieldCheck,
  Wallet as WalletIcon,
} from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, HeaderActions, Screen, ScreenHeader } from '@/components/layout';
import { Avatar, Card, KpiBox, ListRow, Pill, RiskBadge, Text } from '@/components/ui';
import { SessionActions } from '@/components/wallet';
import { notificationsApi, usersApi } from '@/lib/api';
import type { MeOut, UserRole } from '@/lib/api/types';
import { formatAmount, formatBps, formatBpsSigned } from '@/lib/format';
import { colors, spacing } from '@/theme';

/**
 * Figma 8a/8b · Profil (node 27:436 · 27:569) — `GET /users/me`.
 * Menü iki rolde ortaktır; trader'da "Risk profili" yerine "Strateji & komisyon"
 * satırı görünür.
 */
export function ProfileScreen({ role }: { role: UserRole }) {
  const router = useRouter();

  const me = useQuery({ queryKey: ['users', 'me'], queryFn: usersApi.me });
  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: notificationsApi.unreadCount,
  });

  const isTrader = role === 'trader';

  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Profile" right={<HeaderActions />} />
      <View style={styles.body}>
        <AsyncBoundary query={me}>
          {(user) => (
            <>
              <Card style={styles.header}>
                <View style={styles.headerTop}>
                  <Avatar initials={user.display_name} size="lg" />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="h1">{user.display_name}</Text>
                    <Text variant="caption" color="text3">
                      @{user.username}
                    </Text>
                  </View>
                  <Pill label={isTrader ? 'Trader' : 'Customer'} tone="navy" />
                </View>
                <View style={styles.pills}>
                  {(user.markets ?? []).map((m) => (
                    <Pill key={m} label={m} />
                  ))}
                  <RiskBadge level={isTrader ? user.risk_level : user.risk_profile} />
                </View>
                {user.bio ? (
                  <Text variant="body" color="text2">
                    {user.bio}
                  </Text>
                ) : null}
              </Card>

              {isTrader ? <TraderStatsCard user={user} /> : <CustomerTermsCard user={user} />}

              {isTrader ? <PortfolioCard text={user.portfolio} own /> : null}

              <Card style={styles.menu}>
                <MenuRow
                  icon={<Pencil size={18} color={colors.navy900} />}
                  title="Edit profile"
                  subtitle={
                    isTrader
                      ? 'Name, bio, strategy and portfolio'
                      : 'Name and bio'
                  }
                  onPress={() => router.push('/profile/edit')}
                />
                <MenuRow
                  icon={<WalletIcon size={18} color={colors.navy900} />}
                  title="Wallet"
                  subtitle="Balances, deposits and withdrawals"
                  onPress={() => router.push('/wallet')}
                />
                <MenuRow
                  icon={<Bell size={18} color={colors.navy900} />}
                  title="Notifications"
                  subtitle={unread.data?.unread ? `${unread.data.unread} unread` : 'All caught up'}
                  onPress={() => router.push('/notifications')}
                />
                <MenuRow
                  icon={<LineChart size={18} color={colors.navy900} />}
                  title={isTrader ? 'Strategy & commission' : 'Risk profile'}
                  subtitle={
                    isTrader
                      ? user.commission_bps != null
                        ? `${formatBps(user.commission_bps)} commission`
                        : 'Not set yet'
                      : (user.risk_profile ?? 'Not set yet')
                  }
                  onPress={() => router.push('/listing/create')}
                />
                <MenuRow
                  icon={<ShieldCheck size={18} color={colors.navy900} />}
                  title="Security"
                  subtitle="Your key stays on this device"
                  onPress={() => router.push('/wallet')}
                />
                <MenuRow
                  icon={<HelpCircle size={18} color={colors.navy900} />}
                  title="Help & support"
                  subtitle="How escrow and settlement work"
                  onPress={() => router.push('/(auth)/onboarding')}
                />
              </Card>

              <SessionActions />
            </>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function TraderStatsCard({ user }: { user: MeOut }) {
  const s = user.stats;
  if (!s) return null;
  return (
    <View style={styles.kpis}>
      <KpiBox
        label="Total return"
        value={formatBpsSigned(s.total_return_bps ?? 0)}
        signed={s.total_return_bps ?? 0}
        style={styles.kpi}
      />
      <KpiBox
        label="Managed"
        value={formatAmount(s.managed_capital, '')}
        sub={`${s.active_agreements ?? 0} active`}
        style={styles.kpi}
      />
      <KpiBox
        label="Rating"
        value={s.rating_count ? Number(s.rating_avg).toFixed(1) : '—'}
        sub={`${s.rating_count ?? 0} reviews`}
        style={styles.kpi}
      />
      <KpiBox label="Win rate" value={formatBps(s.win_rate_bps ?? 0)} style={styles.kpi} />
    </View>
  );
}

function CustomerTermsCard({ user }: { user: MeOut }) {
  return (
    <View style={styles.kpis}>
      <KpiBox
        label="Budget"
        value={user.budget_amount ? formatAmount(user.budget_amount, '') : '—'}
        sub="used for matching"
        style={styles.kpi}
      />
      <KpiBox label="Risk preference" value={user.risk_profile ?? '—'} style={styles.kpi} />
    </View>
  );
}

/**
 * Trader'ın geçmişini kendi cümleleriyle anlattığı bölüm.
 *
 * İstatistikler zincirden geliyor; bu onların anlatısı. Kendi profilinde boşken
 * de gösterilir ki doldurulacak bir yer olduğu belli olsun — başkasının
 * profilinde boşsa hiç çizilmez.
 */
export function PortfolioCard({ text, own = false }: { text?: string | null; own?: boolean }) {
  if (!text && !own) return null;
  return (
    <Card style={styles.portfolio}>
      <View style={styles.portfolioHead}>
        <FileText size={16} color={colors.text2} />
        <Text variant="captionStrong" color="text2">
          Portfolio
        </Text>
      </View>
      {text ? (
        <Text variant="body" color="text2">
          {text}
        </Text>
      ) : (
        <Text variant="caption" color="text3">
          Tell investors what you have traded and how it went. They see your numbers anyway — this is
          the story behind them.
        </Text>
      )}
    </Card>
  );
}

function MenuRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      leading={<View style={styles.icon}>{icon}</View>}
      trailing={<ChevronRight size={18} color={colors.text3} />}
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.md },
  header: { gap: spacing.sm },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kpi: { flexGrow: 1, flexBasis: '46%', minWidth: 0 },
  portfolio: { gap: spacing.sm },
  portfolioHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  menu: { paddingVertical: 0 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.navy050,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
