import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/layout';
import { Button, Card, Pill, Text } from '@/components/ui';
import { WalletConnectSheet } from '@/components/wallet';
import { metaApi } from '@/lib/api';
import { networkLabel, userMessage } from '@/lib/errors';
import { stellarConfig } from '@/lib/stellar';
import { wallet } from '@/lib/wallet';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

/**
 * Figma 1d · Giriş · Cüzdan ile (node 19:109)
 * Tasarımdaki MetaMask/Coinbase/Trust listesi Stellar'a uyarlandı (notlar §4.2):
 * web'de Stellar Wallets Kit modalı, mobilde WalletConnect v2 (FE-13).
 *
 * FE-04: SEP-10 hataları (yanlış ağ, reddedilen imza, sunucuya ulaşılamadı) ve
 * oturum süresi dolduğunda store'dan gelen uyarı burada gösterilir.
 */
export default function Login() {
  const router = useRouter();
  const signIn = useSession((s) => s.signIn);
  const sessionError = useSession((s) => s.error);
  const clearError = useSession((s) => s.clearError);
  const pairingUri = useSession((s) => s.pairingUri);
  const cancelPairing = useSession((s) => s.cancelPairing);
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
  const connectLabel =
    Platform.OS === 'web' ? 'Connect wallet (Freighter, xBull, Albedo…)' : 'Connect wallet';

  return (
    <Screen contentStyle={styles.content}>
      <View style={styles.logo}>
        <Text variant="h2" color={colors.onNavy}>
          TK
        </Text>
      </View>
      <Text variant="display">Welcome</Text>
      <Text variant="body" color="text2">
        Connect your Stellar wallet to continue
      </Text>
      <View style={styles.status}>
        <Pill label={`Network: ${networkLabel()}`} tone="navy" />
        {backend.isPending ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={colors.text3} />
            <Text variant="caption" color="text3">
              Checking the server…
            </Text>
          </View>
        ) : backend.isError ? (
          <Text variant="caption" color="loss">
            Server unreachable — signing in may not work right now.
          </Text>
        ) : networkMismatch ? (
          <Text variant="caption" color="loss">
            Server is on {backend.data.network}, the app is on {networkLabel()}.
          </Text>
        ) : (
          <Text variant="caption" color={colors.profit}>
            Server connected · {backend.data?.home_domain}
          </Text>
        )}
      </View>

      <Card style={styles.card}>
        {wallet.available ? (
          <Button title={connectLabel} onPress={onConnect} loading={busy} fullWidth />
        ) : (
          <>
            <Text variant="bodyStrong">Wallet connection needs setup</Text>
            <Text variant="caption" color="text2">
              Mobile sign-in uses WalletConnect. Add EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID to your
              .env file (free project ID at cloud.reown.com) and restart the app.
            </Text>
          </>
        )}
        <Text variant="caption" color="text3">
          {Platform.OS === 'web'
            ? `No Freighter yet? Get it at freighter.app — and switch it to ${networkLabel()}.`
            : `Works with Lobstr and xBull. Switch your wallet to ${networkLabel()} first.`}
        </Text>
      </Card>

      <Text variant="caption" color="text2" align="center">
        Signing in asks your wallet to sign a SEP-10 challenge. It is free and moves no funds.
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
          No account yet?
        </Text>
        <Button
          title="Sign up"
          variant="ghost"
          size="sm"
          onPress={() => router.push('/(auth)/register/role')}
        />
      </View>

      <WalletConnectSheet uri={pairingUri} onClose={cancelPairing} />
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
