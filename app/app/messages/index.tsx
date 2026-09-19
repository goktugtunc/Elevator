import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { Card, ListRow, Pill, Text } from '@/components/ui';
import { conversationsApi } from '@/lib/api';
import type { ConversationOut } from '@/lib/api/types';
import { formatRelative } from '@/lib/format';
import { spacing } from '@/theme';

/**
 * Figma 9a · Mesajlar (node 28:171) — `GET /conversations`.
 * Sohbetler teklif ya da sözleşme üzerinden açılır; okunmamış sayısı sunucudan gelir.
 */
export default function Messages() {
  const router = useRouter();

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => conversationsApi.list({ limit: 50 }),
    refetchInterval: 20_000,
  });

  return (
    <Screen padded={false}>
      <TopBar title="Messages" />
      <View style={styles.body}>
        <AsyncBoundary
          query={conversations}
          isEmpty={(page) => page.items.length === 0}
          empty={
            <EmptyState
              title="No conversations yet"
              body="A conversation opens when an offer is accepted, so you can agree on the details."
            />
          }
        >
          {(page) => (
            <Card style={styles.list}>
              {page.items.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  onPress={() => router.push(`/messages/${c.id}`)}
                />
              ))}
            </Card>
          )}
        </AsyncBoundary>
      </View>
    </Screen>
  );
}

function ConversationRow({
  conversation: c,
  onPress,
}: {
  conversation: ConversationOut;
  onPress: () => void;
}) {
  const unread = c.unread_count ?? 0;
  return (
    <ListRow
      title={c.other_user.display_name}
      subtitle={c.last_message?.body ?? 'No messages yet'}
      initials={c.other_user.display_name}
      trailing={
        <View style={styles.right}>
          <Text variant="caption" color="text3">
            {formatRelative(c.last_message_at ?? c.created_at)}
          </Text>
          {unread > 0 ? <Pill label={String(unread)} tone="navy" /> : null}
        </View>
      }
      chevron
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'] },
  list: { paddingVertical: 0 },
  right: { alignItems: 'flex-end', gap: 4 },
});
