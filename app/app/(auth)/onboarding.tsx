import { useRouter } from 'expo-router';
import { Compass, ShieldCheck, TrendingUp, type LucideIcon } from 'lucide-react-native';
import { useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Screen } from '@/components/layout';
import { Button, Text } from '@/components/ui';
import { useSession } from '@/store/session';
import { colors, layout, radius, spacing } from '@/theme';

/** Figma 1a–1c · Onboarding · Slayt 1/3 – 3/3 (node 19:13, 19:45, 19:77) */
const SLIDES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Compass,
    title: 'Trader’ları Keşfet',
    body: 'Kaydırarak trader’ları incele; sana uygun olanla eşleş. Trader’sın ise yatırımcı ilanlarını keşfet.',
  },
  {
    icon: ShieldCheck,
    title: 'Güvenli Sözleşme',
    body: 'Komisyon oranı, süre ve risk limitleri sözleşmeyle güvence altında — sermayen her zaman senin cüzdanında.',
  },
  {
    icon: TrendingUp,
    title: 'Hareketleri Takip Et',
    body: 'Trader’ın işlemlerini, ilanlarına gelen etkileşimleri ve bildirimleri canlı izle.',
  },
];

export default function Onboarding() {
  const router = useRouter();
  const markSeen = useSession((s) => s.markOnboardingSeen);
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList>(null);
  const width = Math.min(Dimensions.get('window').width, layout.maxContentWidth);

  const finish = async () => {
    await markSeen();
    router.replace('/(auth)/login');
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  return (
    <Screen scroll={false} padded={false}>
      <FlatList
        ref={listRef}
        data={SLIDES}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        keyExtractor={(s) => s.title}
        renderItem={({ item }) => {
          const Icon = item.icon;
          return (
            <View style={[styles.slide, { width }]}>
              <View style={styles.tile}>
                <Icon size={52} color={colors.navy900} strokeWidth={1.6} />
              </View>
              <View style={styles.text}>
                <Text variant="h1" align="center">
                  {item.title}
                </Text>
                <Text variant="body" color="text2" align="center">
                  {item.body}
                </Text>
              </View>
            </View>
          );
        }}
      />
      <View style={styles.dots}>
        {SLIDES.map((s, i) => (
          <View key={s.title} style={[styles.dot, i === index && styles.dotActive]} />
        ))}
      </View>
      <View style={styles.actions}>
        {index < SLIDES.length - 1 ? (
          <>
            <Button title="Geç" variant="ghost" onPress={finish} />
            <Button
              title="Devam"
              onPress={() => listRef.current?.scrollToIndex({ index: index + 1, animated: true })}
              style={{ flex: 1 }}
            />
          </>
        ) : (
          <Button title="Başla" onPress={finish} fullWidth style={{ flex: 1 }} />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { flexGrow: 1 },
  slide: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 24,
  },
  tile: {
    width: 120,
    height: 120,
    borderRadius: radius.lg,
    backgroundColor: colors.navy050,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { gap: spacing.md, maxWidth: 334 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: spacing.md },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderStrong },
  dotActive: { width: 18, backgroundColor: colors.navy900 },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: layout.screenPaddingH,
    paddingBottom: spacing.lg,
  },
});
