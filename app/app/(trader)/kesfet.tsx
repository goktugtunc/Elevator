import { useMutation, useQuery } from '@tanstack/react-query';
import { Bookmark, Check, RotateCcw, X } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import {
  CapitalListingCard,
  OfferSheet,
  SwipeDeck,
  type OfferDraft,
  type SwipeDeckHandle,
} from '@/components/discover';
import { Screen, ScreenHeader } from '@/components/layout';
import { Button, Card, Text } from '@/components/ui';
import { listingsApi } from '@/lib/api';
import { userMessage } from '@/lib/errors';
import { colors, layout, radius, shadow, spacing } from '@/theme';
import type { Listing } from '@/types';

/**
 * Figma 2b/2d · Keşfet · Trader (node 21:160, 21:414) — FE-06.
 * Sağa kaydır = Teklif Ver (bottom sheet açılır) · Sola kaydır = Geç · Yer imi = Kaydet.
 * Veri: `GET /listings?kind=capital` (BE-03). Sahte veri yok.
 */
export default function TraderKesfet() {
  const deckRef = useRef<SwipeDeckHandle>(null);
  const [top, setTop] = useState<Listing | null>(null);
  const [offerTarget, setOfferTarget] = useState<Listing | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [deckKey, setDeckKey] = useState(0);

  const listings = useQuery({
    queryKey: ['listings', 'discover', 'capital'],
    queryFn: () => listingsApi.discover({ kind: 'capital' }),
  });

  const createOffer = useMutation({
    mutationFn: ({ listing, draft }: { listing: Listing; draft: OfferDraft }) =>
      listingsApi.createOffer(listing.id, draft),
    onSuccess: () => {
      setOfferTarget(null);
      setNotice({ tone: 'ok', text: 'Teklifin müşteriye iletildi.' });
    },
  });

  const save = useMutation({
    mutationFn: (listing: Listing) => listingsApi.save(listing.id),
    onSuccess: () => setNotice({ tone: 'ok', text: 'İlan kaydedildi.' }),
    onError: (err) => setNotice({ tone: 'error', text: userMessage(err) }),
  });

  const onSwipe = useCallback((listing: Listing, direction: 'left' | 'right') => {
    setNotice(null);
    if (direction === 'right') setOfferTarget(listing);
  }, []);

  const items = listings.data?.items ?? [];

  return (
    <Screen riskStrip={false} padded={false} scroll={false}>
      <ScreenHeader title="Keşfet" subtitle="Sermaye ilanlarını incele, teklif ver" />

      <View style={styles.body}>
        {listings.isPending ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.navy900} />
            <Text variant="caption" color="text2">
              İlanlar yükleniyor…
            </Text>
          </View>
        ) : listings.isError ? (
          <Card style={styles.state}>
            <Text variant="h2">İlanlar alınamadı</Text>
            <Text variant="body" color="text2">
              {userMessage(listings.error)}
            </Text>
            <Button title="Tekrar dene" onPress={() => listings.refetch()} />
          </Card>
        ) : items.length === 0 ? (
          <Card style={styles.state}>
            <Text variant="h2">Şimdilik ilan yok</Text>
            <Text variant="body" color="text2">
              Müşteriler sermaye ilanı oluşturduğunda burada görünecek. Hizmet ilanı yayınlarsan
              müşteriler sana da teklif isteyebilir.
            </Text>
            <Button title="Yenile" variant="secondary" onPress={() => listings.refetch()} />
          </Card>
        ) : (
          <SwipeDeck<Listing>
            key={deckKey}
            ref={deckRef}
            data={items}
            keyExtractor={(l) => l.id}
            renderCard={(l) => <CapitalListingCard listing={l} />}
            onSwipe={onSwipe}
            onTopChange={setTop}
            rightLabel="TEKLİF VER"
            renderEmpty={() => (
              <Card style={styles.state}>
                <Text variant="h2">Bugünlük bu kadar</Text>
                <Text variant="body" color="text2">
                  Tüm ilanları gördün. Yeni ilanlar için listeyi yenileyebilirsin.
                </Text>
                <Button
                  title="Baştan bak"
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
              label="Geç"
              onPress={() => deckRef.current?.swipe('left')}
              disabled={!top}
              tint={colors.loss}
            >
              <X size={22} color={colors.loss} />
            </ActionButton>
            <ActionButton
              label="Kaydet"
              onPress={() => top && save.mutate(top)}
              disabled={!top || save.isPending}
              tint={colors.navy900}
            >
              <Bookmark size={20} color={colors.navy900} />
            </ActionButton>
            <ActionButton
              label="Teklif Ver"
              onPress={() => deckRef.current?.swipe('right')}
              disabled={!top}
              tint={colors.profit}
            >
              <Check size={22} color={colors.profit} />
            </ActionButton>
          </View>
        ) : null}
      </View>

      <OfferSheet
        key={offerTarget?.id ?? 'offer-sheet'}
        listing={offerTarget}
        visible={offerTarget !== null}
        onClose={() => {
          setOfferTarget(null);
          createOffer.reset();
        }}
        submitting={createOffer.isPending}
        error={createOffer.isError ? userMessage(createOffer.error) : null}
        onSubmit={(draft) => offerTarget && createOffer.mutate({ listing: offerTarget, draft })}
      />
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
