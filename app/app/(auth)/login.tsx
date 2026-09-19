import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/layout';
import { Button, Card, Text } from '@/components/ui';
import { wallet } from '@/lib/wallet';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

/**
 * Figma 1d · Giriş · Cüzdan ile (node 19:109)
 * Tasarımdaki MetaMask/Coinbase/Trust listesi Stellar'a uyarlandı (notlar §4.2):
 * web'de Stellar Wallets Kit modalı (Freighter, xBull, Albedo, Lobstr…), mobilde WalletConnect (sprint).
 */
export default function Login() {
  const router = useRouter();
  const signIn = useSession((s) => s.signIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bağlantı kurulamadı');
    } finally {
      setBusy(false);
    }
  };

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
            Freighter yüklü değilse: freighter.app
          </Text>
        ) : null}
      </Card>

      <Text variant="caption" color="text2" align="center">
        Giriş için cüzdanından bir SEP-10 imza isteği onaylarsın. Bu işlem için ücret alınmaz.
      </Text>

      {error ? (
        <Text variant="caption" color="loss" align="center">
          {error}
        </Text>
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
  content: { flexGrow: 1, justifyContent: 'center', gap: spacing.md, paddingVertical: 40 },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: colors.navy900,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  card: { gap: spacing.md, marginTop: spacing.lg },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
});
