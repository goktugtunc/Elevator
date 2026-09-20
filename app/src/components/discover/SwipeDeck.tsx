/* eslint-disable react-hooks/immutability -- Reanimated shared value'ları (x.value = …)
   React Compiler kuralının dışındadır; reanimated 4.5 henüz get/set yardımcılarını dışa açmıyor. */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui';
import { colors, fontFamily, layout, radius } from '@/theme';

/**
 * Keşfet destesi (FE-05) — Figma 2a–2d "Swipe Card".
 * Sağa kaydırma = olumlu aksiyon (Teklif İste / Ver), sola = Geç.
 * Kartlar tükendiğinde `renderEmpty` gösterilir; buton aksiyonları için `ref.swipe()`.
 */
export type SwipeDirection = 'left' | 'right';

export interface SwipeDeckHandle {
  swipe: (direction: SwipeDirection) => void;
}

export interface SwipeDeckProps<T> {
  data: T[];
  keyExtractor: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  onSwipe: (item: T, direction: SwipeDirection) => void;
  /** Deste bittiğinde gösterilecek içerik. */
  renderEmpty?: () => ReactNode;
  /** Üstteki kart değiştiğinde çağrılır (buton aksiyonları hangi ilana ait bilsin). */
  onTopChange?: (item: T | null) => void;
  leftLabel?: string;
  rightLabel?: string;
}

const SWIPE_THRESHOLD = 110;
const ROTATION_DEG = 10;

function SwipeDeckInner<T>(
  {
    data,
    keyExtractor,
    renderCard,
    onSwipe,
    renderEmpty,
    onTopChange,
    leftLabel = 'SKIP',
    rightLabel = 'OFFER',
  }: SwipeDeckProps<T>,
  ref: React.Ref<SwipeDeckHandle>,
) {
  const { width } = useWindowDimensions();
  const flyOut = Math.min(width, layout.maxContentWidth) * 1.4;
  const [index, setIndex] = useState(0);

  const x = useSharedValue(0);
  const y = useSharedValue(0);

  const current = data[index];
  const next = data[index + 1];

  useEffect(() => {
    onTopChange?.(current ?? null);
  }, [current, onTopChange]);

  const commit = useCallback(
    (direction: SwipeDirection) => {
      const item = data[index];
      x.value = 0;
      y.value = 0;
      setIndex((i) => i + 1);
      if (item) onSwipe(item, direction);
    },
    [data, index, onSwipe, x, y],
  );

  const animateOut = useCallback(
    (direction: SwipeDirection) => {
      const target = direction === 'right' ? flyOut : -flyOut;
      x.value = withTiming(target, { duration: 180 }, (finished) => {
        if (finished) runOnJS(commit)(direction);
      });
    },
    [commit, flyOut, x],
  );

  useImperativeHandle(ref, () => ({
    swipe: (direction) => {
      if (data[index]) animateOut(direction);
    },
  }));

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      x.value = e.translationX;
      y.value = e.translationY * 0.25;
    })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > SWIPE_THRESHOLD) {
        const direction: SwipeDirection = e.translationX > 0 ? 'right' : 'left';
        const target = direction === 'right' ? flyOut : -flyOut;
        x.value = withTiming(target, { duration: 180 }, (finished) => {
          if (finished) runOnJS(commit)(direction);
        });
        y.value = withTiming(0, { duration: 180 });
        return;
      }
      x.value = withSpring(0, { damping: 18 });
      y.value = withSpring(0, { damping: 18 });
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      {
        rotate: `${interpolate(x.value, [-flyOut, 0, flyOut], [-ROTATION_DEG, 0, ROTATION_DEG])}deg`,
      },
    ],
  }));

  const likeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, SWIPE_THRESHOLD], [0, 1], 'clamp'),
  }));

  const nopeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-SWIPE_THRESHOLD, 0], [1, 0], 'clamp'),
  }));

  const nextStyle = useAnimatedStyle(() => {
    const progress = interpolate(Math.abs(x.value), [0, SWIPE_THRESHOLD], [0, 1], 'clamp');
    return {
      transform: [{ scale: 0.94 + progress * 0.06 }, { translateY: 12 - progress * 12 }],
      opacity: 0.6 + progress * 0.4,
    };
  });

  if (!current) {
    return <View style={styles.wrap}>{renderEmpty?.() ?? null}</View>;
  }

  return (
    <View style={styles.wrap}>
      {next ? (
        <Animated.View
          key={keyExtractor(next)}
          style={[styles.card, styles.behind, nextStyle]}
          pointerEvents="none"
        >
          {renderCard(next)}
        </Animated.View>
      ) : null}

      <GestureDetector gesture={pan}>
        <Animated.View key={keyExtractor(current)} style={[styles.card, cardStyle]}>
          {renderCard(current)}
          <Animated.View style={[styles.stamp, styles.stampRight, likeStyle]} pointerEvents="none">
            <Text
              style={[styles.stampText, styles.stampTextRight]}
              color={colors.profit}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {rightLabel}
            </Text>
          </Animated.View>
          <Animated.View style={[styles.stamp, styles.stampLeft, nopeStyle]} pointerEvents="none">
            <Text
              style={[styles.stampText, styles.stampTextLeft]}
              color={colors.loss}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {leftLabel}
            </Text>
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** Generic bileşen + forwardRef: tip bilgisini koruyarak dışa açılır. */
export const SwipeDeck = forwardRef(SwipeDeckInner) as <T>(
  props: SwipeDeckProps<T> & { ref?: React.Ref<SwipeDeckHandle> },
) => ReturnType<typeof SwipeDeckInner>;

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center' },
  card: { width: '100%' },
  behind: { position: 'absolute', left: 0, right: 0 },
  /**
   * Seçim damgası kartın **tamamını** kaplar ve yazı çapraz durur: köşedeki
   * küçük rozet, kaydırma sırasında hangi seçimin yapıldığını yeterince net
   * göstermiyordu. Renk tonu da karta yayılıyor, karar bir bakışta okunuyor.
   */
  stamp: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 3,
  },
  stampRight: { borderColor: colors.profit, backgroundColor: 'rgba(22, 163, 74, 0.16)' },
  stampLeft: { borderColor: colors.loss, backgroundColor: 'rgba(220, 38, 38, 0.16)' },
  stampText: {
    fontFamily: fontFamily.extraBold,
    fontSize: 44,
    lineHeight: 52,
    letterSpacing: 2,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  stampTextRight: { transform: [{ rotate: '-18deg' }] },
  stampTextLeft: { transform: [{ rotate: '18deg' }] },
});
