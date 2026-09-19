import { AlertCircle } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Text } from './Text';
import { errorCode, userMessage } from '@/lib/errors';
import { colors, radius, spacing } from '@/theme';

/**
 * Hataların tek gösterim biçimi. Her ekran kendi kırmızı kutusunu çizdiği için
 * kimi yerde hata görünüyor, kimi yerde yutuluyordu.
 *
 * Gösterilenler:
 *   - başlık (eylemi anlatır: "Sign-up failed", "Could not load")
 *   - sunucunun kendi mesajı (bkz. lib/errors.ts)
 *   - varsa makine okunur kod — destek istendiğinde işe yarar, küçük punto
 *   - varsa yeniden deneme düğmesi
 */
export function ErrorNotice({
  title = 'Something went wrong',
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  if (!error) return null;
  const code = errorCode(error);
  return (
    <View style={styles.box} accessibilityRole="alert">
      <View style={styles.head}>
        <AlertCircle size={16} color={colors.loss} />
        <Text variant="captionStrong" color="loss">
          {title}
        </Text>
      </View>
      <Text variant="caption" color="text2">
        {userMessage(error)}
      </Text>
      {code ? (
        <Text variant="caption" color="text3" selectable>
          Code: {code}
        </Text>
      ) : null}
      {onRetry ? (
        <Button title={retryLabel} variant="secondary" size="sm" onPress={onRetry} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.redBg,
    alignItems: 'flex-start',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
