import { ChevronsRight } from 'lucide-react-native';
import { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Text } from './Text';
import { colors, radius } from '@/theme';

const KNOB = 44;
const PAD = 4;

/**
 * Figma "Onaylamak için kaydır" — geri alınamaz zincir üstü adımlar (escrow'a
 * para kilitleme, sonuçlandırma) için kasıtlı bir onay hareketi.
 * Kullanıcı kolu sonuna kadar sürüklemezse hiçbir şey olmaz.
 */
export function SlideToConfirm({
  label,
  confirmLabel = 'Release to confirm',
  onConfirm,
  disabled,
  tone = 'primary',
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'danger';
}) {
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const max = Math.max(width - KNOB - PAD * 2, 1);
  const bg = tone === 'danger' ? colors.loss : colors.navy900;

  const pan = Gesture.Pan()
    .enabled(!disabled && width > 0)
    .onChange((e) => {
      x.value = Math.min(Math.max(x.value + e.changeX, 0), max);
    })
    .onEnd(() => {
      if (x.value >= max - 2) {
        runOnJS(onConfirm)();
        x.value = withSpring(0, { damping: 20 });
      } else {
        x.value = withSpring(0, { damping: 20 });
      }
    });

  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ width: x.value + KNOB }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, max * 0.6], [1, 0], 'clamp'),
  }));
  const confirmStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [max * 0.6, max], [0, 1], 'clamp'),
  }));

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View
      style={[styles.track, disabled && styles.disabled]}
      onLayout={onLayout}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityHint="Slide all the way to the right to confirm"
    >
      <Animated.View style={[styles.fill, { backgroundColor: bg }, fillStyle]} />
      <Animated.View style={[styles.labelWrap, labelStyle]} pointerEvents="none">
        <Text variant="bodyStrong" color={colors.text2}>
          {label}
        </Text>
      </Animated.View>
      <Animated.View style={[styles.labelWrap, confirmStyle]} pointerEvents="none">
        <Text variant="bodyStrong" color={colors.onNavy}>
          {confirmLabel}
        </Text>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.knob, { backgroundColor: bg }, knobStyle]}>
          <ChevronsRight size={22} color={colors.onNavy} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: KNOB + PAD * 2,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    padding: PAD,
    overflow: 'hidden',
  },
  disabled: { opacity: 0.5 },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: radius.full,
    opacity: 0.18,
  },
  labelWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
