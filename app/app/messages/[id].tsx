import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Send } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AsyncBoundary, EmptyState, Screen, TopBar } from '@/components/layout';
import { Button, Text } from '@/components/ui';
import { conversationsApi } from '@/lib/api';
import type { MessageOut } from '@/lib/api/types';
import { userMessage } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { colors, fontFamily, radius, spacing } from '@/theme';

/**
 * Figma 9b · Sohbet (node 28:266) — `GET|POST /conversations/{id}/messages`.
 * Mesajlar kronolojik (eski → yeni) gelir; ekran açıldığında okundu işaretlenir
 * ve 10 saniyede bir tazelenir (sunucuda websocket yok).
 */
export default function Conversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  const conversation = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => conversationsApi.byId(id),
    enabled: Boolean(id),
  });

  const messages = useQuery({
    queryKey: ['conversation', id, 'messages'],
    queryFn: () => conversationsApi.messages(id, { limit: 100 }),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });

  const send = useMutation({
    mutationFn: (body: string) => conversationsApi.send(id, body),
    onSuccess: () => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['conversation', id, 'messages'] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  // Ekran açıkken gelen mesajlar okundu sayılır.
  useEffect(() => {
    if (!id || !messages.data?.items.length) return;
    conversationsApi
      .markRead(id)
      .then(() => qc.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => undefined);
  }, [id, messages.data?.items.length, qc]);

  const other = conversation.data?.other_user;

  return (
    <Screen padded={false} scroll={false}>
      <TopBar
        title={other?.display_name ?? 'Conversation'}
        right={
          conversation.data?.agreement_id ? (
            <Button
              title="Agreement"
              variant="ghost"
              size="sm"
              onPress={() => router.push(`/contract/${conversation.data.agreement_id}`)}
            />
          ) : null
        }
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.thread}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          <AsyncBoundary
            query={messages}
            isEmpty={(page) => page.items.length === 0}
            empty={
              <EmptyState
                title="Say hello"
                body="Agree on the terms here before anything moves on-chain."
              />
            }
          >
            {(page) => <>{page.items.map((m) => <Bubble key={m.id} message={m} />)}</>}
          </AsyncBoundary>
        </ScrollView>

        {send.isError ? (
          <Text variant="caption" color="loss" style={styles.error}>
            {userMessage(send.error)}
          </Text>
        ) : null}

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Write a message"
            placeholderTextColor={colors.text3}
            style={styles.input}
            multiline
            maxLength={2000}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!draft.trim() || send.isPending}
            onPress={() => send.mutate(draft.trim())}
            style={[styles.send, (!draft.trim() || send.isPending) && styles.sendDisabled]}
          >
            <Send size={18} color={colors.onNavy} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Bubble({ message }: { message: MessageOut }) {
  const mine = message.is_mine ?? false;
  return (
    <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text variant="body" color={mine ? colors.onNavy : colors.text}>
          {message.body}
        </Text>
        <Text variant="caption" color={mine ? colors.navy050 : colors.text3}>
          {formatRelative(message.created_at)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  thread: { padding: spacing.lg, gap: spacing.sm },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', padding: spacing.md, borderRadius: radius.lg, gap: 2 },
  bubbleMine: { backgroundColor: colors.navy900, borderBottomRightRadius: radius.sm },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: radius.sm,
  },
  error: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    fontFamily: fontFamily.regular,
    fontSize: 15,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.navy900,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
});
