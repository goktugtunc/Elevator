import type { UseQueryResult } from '@tanstack/react-query';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ErrorNotice, Text } from '@/components/ui';
import { colors, spacing } from '@/theme';

/**
 * Liste/panel ekranlarının ortak üç durumu: yükleniyor · hata · boş.
 * Sahte veri yok — sunucu hata verirse ekran hatayı gösterir ve yeniden dener
 * (gelistirme-notlari §3.6).
 */
export function AsyncBoundary<T>({
  query,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T>;
  /** Veri geldi ama gösterilecek bir şey yok mu? */
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text3} />
      </View>
    );
  }
  if (query.isError) {
    return <ErrorNotice title="Could not load" error={query.error} onRetry={() => query.refetch()} />;
  }
  if (isEmpty?.(query.data) && empty) return <>{empty}</>;
  return <>{children(query.data)}</>;
}

/** Boş liste anlatımı — başlık + açıklama (+ opsiyonel eylem). */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Text variant="bodyStrong" align="center">
        {title}
      </Text>
      {body ? (
        <Text variant="caption" color="text2" align="center">
          {body}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing['2xl'], alignItems: 'center' },
  empty: {
    gap: spacing.sm,
    paddingVertical: spacing['2xl'],
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
});
