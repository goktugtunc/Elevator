import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/layout';
import { Button, Card, Pill, Text } from '@/components/ui';
import { metaApi } from '@/lib/api';
import { networkLabel, userMessage } from '@/lib/errors';
import { stellarConfig } from '@/lib/stellar';
import { wallet } from '@/lib/wallet';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

/**
 * Figma 1d · Giriş · Cüzdan ile (node 19:109)
 * Tasarımdaki MetaMask/Coinbase/Trust listesi Stellar'a uyarlandı (notlar §4.2):
 * web'de Stellar Wallets Kit modalı (Freighter, xBull, Albedo, Lobstr…), mobilde WalletConnect (sprint).
 *
 * FE-04: SEP-10 hataları (yanlış ağ, reddedilen imza, sunucuya ulaşılamadı) ve
 * oturum süresi dolduğunda store'dan gelen uyarı burada gösterilir.
 */
export default function Login() {
  const router = useRouter();
  const signIn = useSession((s) => s.signIn);
  const sessionError = useSession((s) => s.error);
  const clearError = useSession((s) => s.clearError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sunucu ayakta mı ve aynı ağda mı? (FE-04 — giriş denemeden önce görülür.)
  const backend = useQuery({
    queryKey: ['meta', 'config'],
    queryFn: metaApi.config,
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const networkMismatch =
    backend.data !== undefined &&
    backend.data.network_passphrase !== stellarConfig.networkPassphrase;

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    clearError();
    try {
      await signIn();
      router.replace('/');
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const notice = error ?? sessionError;

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.logo}>
        <Text variant="h2" color={colors.onNavy}>
          TK
        </Text>
      </View>
      <Text variant="display">Hoş geldin</Text>
      <Text variant="body" color="text2">
        Devam etmek için cüzdanını bağla
      </Text>
      <View style={styles.status}>
        <Pill label={`Ağ: ${networkLabel()}`} tone="navy" />
        {backend.isPending ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={colors.text3} />
            <Text variant="caption" color="text3">
              Sunucu kontrol ediliyor…
            </Text>
          </View>
        ) : backend.isError ? (
          <Text variant="caption" color="loss">
            Sunucuya ulaşılamıyor — giriş şu an yapılamayabilir.
          </Text>
        ) : networkMismatch ? (
          <Text variant="caption" color="loss">
            Sunucu {backend.data.network} ağında, uygulama {networkLabel()} ağında.
          </Text>
        ) : (
          <Text variant="caption" color={colors.profit}>
            Sunucu bağlı · {backend.data?.home_domain}
          </Text>
        )}
      </View>

      <Card style={styles.card}>
        {wallet.available ? (
          <Button
            title="Cüzdan Bağla (Freighter, xBull, Albedo…)"
            onPress={onConnect}
            loading={busy}
            fullWidth
          />
        ) : (
          <>
            <Text variant="bodyStrong">Mobil cüzdan bağlantısı hazırlanıyor</Text>
            <Text variant="caption" color="text2">
              Freighter mobile + WalletConnect prototipi sprint kapsamında. Şimdilik web sürümünü
              kullanın.
            </Text>
          </>
        )}
        {Platform.OS === 'web' ? (
          <Text variant="caption" color="text3">
            Freighter yüklü değilse: freighter.app · Cüzdanı {networkLabel()} ağına almayı unutma.
          </Text>
        ) : null}
      </Card>

      <Text variant="caption" color="text2" align="center">
        Giriş için cüzdanından bir SEP-10 imza isteği onaylarsın. Bu işlem için ücret alınmaz.
      </Text>

      {notice ? (
        <View style={styles.notice}>
          <Text variant="caption" color="loss" align="center">
            {notice}
          </Text>
        </View>
      ) : null}

      <View style={styles.footer}>
        <Text variant="body" color="text2">
          Hesabın yok mu?
        </Text>
        <Button
          title="Kayıt Ol"
          variant="ghost"
          size="sm"
          onPress={() => router.push('/(auth)/register/role')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 40,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.navy900,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  status: { gap: spacing.xs },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  card: { gap: spacing.md, marginTop: spacing.lg, alignSelf: 'stretch' },
  notice: {
    alignSelf: 'stretch',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.redBg,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
});
