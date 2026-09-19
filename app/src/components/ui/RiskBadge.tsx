import { StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { colors, radius, spacing } from '@/theme';
import { RISK_LABEL, type RiskLevel } from '@/types';

/** Figma "Risk Badge" — level=low|mid|high → Muhafazakâr / Dengeli / Agresif */
export function RiskBadge({ level }: { level: RiskLevel }) {
  const t = tones[level];
  return (
    <View style={[styles.base, { backgroundColor: t.bg }]}>
      <View style={[styles.dot, { backgroundColor: t.dot }]} />
      <Text variant="captionStrong" color={t.fg}>
        {RISK_LABEL[level]}
      </Text>
    </View>
  );
}

const tones: Record<RiskLevel, { bg: string; fg: string; dot: string }> = {
  low: { bg: colors.greenBg, fg: colors.profit, dot: colors.profit },
  mid: { bg: colors.amberBg, fg: colors.amberInk, dot: colors.amber },
  high: { bg: colors.redBg, fg: colors.loss, dot: colors.loss },
};

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    height: 19,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
