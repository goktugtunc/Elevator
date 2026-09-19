import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Heart, RotateCcw, X } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ServiceListingCard, SwipeDeck, type SwipeDeckHandle } from '@/components/discover';
import { Screen, ScreenHeader } from '@/components/layout';
import { Button, Card, Text } from '@/components/ui';
import { followApi, listingsApi } from '@/lib/api';
import { userMessage } from '@/lib/errors';
import { colors, layout, radius, shadow, spacing } from '@/theme';
import type { Listing } from '@/types';

/**
 * Figma 2a/2c · Keşfet · Müşteri (node 21:30, 21:282) — FE-05.
 * Sağa kaydır = Teklif İste · Sola kaydır = Geç · Kalp = Takip Et.
 * Veri: `GET /listings?kind=service` (BE-03). Sahte veri yok; yükleniyor/boş/hata
 * durumları ekranda gösterilir.
 */
export default function CustomerKesfet() {
  const deckRef = useRef<SwipeDeckHandle>(null);
  const [top, setTop] = useState<Listing | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [deckKey, setDeckKey] = useState(0);

  const listings = useQuery({
    queryKey: ['listings', 'discover', 'service'],
    queryFn: () => listingsApi.discover({ kind: 'service' }),
  });

  const requestOffer = useMutation({
    mutationFn: (listing: Listing) => listingsApi.requestOffer(listing.id),
    onSuccess: () => setNotice({ tone: 'ok', text: 'Your offer request was sent to the trader.' }),
    onError: (err) => setNotice({ tone: 'error', text: userMessage(err) }),
  });

  const follow = useMutation({
    mutationFn: (listing: Listing) => followApi.follow(listing.ownerAddress),
    onSuccess: () => setNotice({ tone: 'ok', text: 'Trader added to your following list.' }),
    onError: (err) => setNotice({ tone: 'error', text: userMessage(err) }),
  });

  const onSwipe = useCallback(
    (listing: Listing, direction: 'left' | 'right') => {
      setNotice(null);
      if (direction === 'right') requestOffer.mutate(listing);
    },
    [requestOffer],
  );

  const items = listings.data?.items ?? [];

  return (
    <Screen riskStrip={false} padded={false} scroll={false}>
      <ScreenHeader title="Discover" subtitle="Swipe through traders that fit you" />

      <View style={styles.body}>
        {listings.isPending ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.navy900} />
            <Text variant="caption" color="text2">
              Loading listings…
            </Text>
          </View>
        ) : listings.isError ? (
          <Card style={styles.state}>
            <Text variant="h2">Could not load listings</Text>
            <Text variant="body" color="text2">
              {userMessage(listings.error)}
            </Text>
            <Button title="Try again" onPress={() => listings.refetch()} />
          </Card>
        ) : items.length === 0 ? (
          <Card style={styles.state}>
            <Text variant="h2">Nothing here yet</Text>
            <Text variant="body" color="text2">
              Service listings from traders show up here. Publish a capital listing and traders can
              make you an offer too.
            </Text>
            <Button title="Refresh" variant="secondary" onPress={() => listings.refetch()} />
          </Card>
        ) : (
          <SwipeDeck<Listing>
            key={deckKey}
            ref={deckRef}
            data={items}
            keyExtractor={(l) => l.id}
            renderCard={(l) => <ServiceListingCard listing={l} />}
            onSwipe={onSwipe}
            onTopChange={setTop}
            rightLabel="REQUEST"
            renderEmpty={() => (
              <Card style={styles.state}>
                <Text variant="h2">That’s everyone for now</Text>
                <Text variant="body" color="text2">
                  You have seen every listing. Refresh to check for new ones.
                </Text>
                <Button
                  title="Start over"
                  variant="secondary"
                  leftIcon={<RotateCcw size={16} color={colors.navy900} />}
                  onPress={() => {
                    setDeckKey((k) => k + 1);
                    listings.refetch();
                  }}
                />
              </Card>
            )}
          />
        )}

        {notice ? (
          <View style={[styles.notice, notice.tone === 'ok' ? styles.noticeOk : styles.noticeErr]}>
            <Text variant="caption" color={notice.tone === 'ok' ? colors.profit : colors.loss}>
              {notice.text}
            </Text>
          </View>
        ) : null}

        {items.length > 0 ? (
          <View style={styles.actions}>
            <ActionButton
              label="Skip"
              onPress={() => deckRef.current?.swipe('left')}
              disabled={!top}
              tint={colors.loss}
            >
              <X size={22} color={colors.loss} />
            </ActionButton>
            <ActionButton
              label="Follow"
              onPress={() => top && follow.mutate(top)}
              disabled={!top || follow.isPending}
              tint={colors.navy900}
            >
              <Heart size={20} color={colors.navy900} />
            </ActionButton>
            <ActionButton
              label="Request offer"
              onPress={() => deckRef.current?.swipe('right')}
              disabled={!top || requestOffer.isPending}
              tint={colors.profit}
            >
              <Check size={22} color={colors.profit} />
            </ActionButton>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function ActionButton({
  label,
  onPress,
  disabled,
  tint,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.action}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        onPress={onPress}
        disabled={disabled}
        style={({ pressed }) => [
          styles.actionButton,
          shadow.card,
          { borderColor: tint },
          pressed && { opacity: 0.85 },
          disabled && { opacity: 0.4 },
        ]}
      >
        {children}
      </Pressable>
      <Text variant="caption" color="text2">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: layout.screenPaddingH,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  state: { gap: spacing.md, alignItems: 'flex-start' },
  notice: { padding: spacing.md, borderRadius: radius.md },
  noticeOk: { backgroundColor: colors.greenBg },
  noticeErr: { backgroundColor: colors.redBg },
  actions: { flexDirection: 'row', justifyContent: 'space-evenly', paddingTop: spacing.xs },
  action: { alignItems: 'center', gap: spacing.xs },
  actionButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
