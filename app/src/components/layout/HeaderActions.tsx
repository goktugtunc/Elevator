import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Bell, MessageCircle } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { conversationsApi, notificationsApi } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';

/**
 * Sekme ekranlarının ortak üst bar eylemleri: mesajlar ve bildirimler.
 * Okunmamış sayıları rozet olarak gösterilir; 60 saniyede bir tazelenir.
 */
export function HeaderActions() {
  const router = useRouter();

  const messages = useQuery({
    queryKey: ['conversations', 'unread'],
    queryFn: conversationsApi.unreadCount,
    refetchInterval: 60_000,
  });

  const notifications = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 60_000,
  });

  return (
    <View style={styles.row}>
      <HeaderIconButton
        label="Messages"
        count={messages.data?.conversations ?? 0}
        onPress={() => router.push('/messages')}
      >
        <MessageCircle size={20} color={colors.navy900} />
      </HeaderIconButton>
      <HeaderIconButton
        label="Notifications"
        count={notifications.data?.unread ?? 0}
        onPress={() => router.push('/notifications')}
      >
        <Bell size={20} color={colors.navy900} />
      </HeaderIconButton>
    </View>
  );
}

/**
 * Başlıktaki yuvarlak simge düğmesi. Başlık dar: etiketli bir düğme eklemek
 * ekran adını iki satıra bölüyor, o yüzden buradaki eylemler simgeyle durur ve
 * adlarını ekran okuyucuya `accessibilityLabel` ile söyler.
 */
export function HeaderIconButton({
  label,
  count = 0,
  onPress,
  children,
}: {
  label: string;
  count?: number;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}, ${count} unread` : label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}
    >
      {children}
      {count > 0 ? (
        <View style={styles.badge}>
          <Text variant="caption" color={colors.onNavy} style={styles.badgeText}>
            {count > 9 ? '9+' : count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  button: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.navy050,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: radius.full,
    backgroundColor: colors.loss,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, lineHeight: 13 },
});
