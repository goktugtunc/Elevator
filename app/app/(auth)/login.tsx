import { useQuery } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/layout';
import { Button, Card, Pill, Text } from '@/components/ui';
import { WalletConnectSheet } from '@/components/wallet';
import { metaApi } from '@/lib/api';
import { networkLabel, userMessage } from '@/lib/errors';
import { stellarConfig } from '@/lib/stellar';
import { FREIGHTER_WALLET_ID, isFreighterAvailable } from '@/lib/wallet';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

/**
 * Figma 1d · Giriş · Cüzdan ile (node 19:109)
 * Tasarımdaki MetaMask/Coinbase/Trust listesi Stellar'a uyarlandı (notlar §4.2):
 * web'de Stellar Wallets Kit modalı, mobilde kendi cüzdan seçim ekranımız:
 * uygulama içi cüzdan · SEP-7 ile harici cüzdan · (varsa) WalletConnect (FE-13).
 *
 * FE-04: SEP-10 hataları (yanlış ağ, reddedilen imza, sunucuya ulaşılamadı) ve
 * oturum süresi dolduğunda store'dan gelen uyarı burada gösterilir.
 */
export default function Login() {
  const router = useRouter();
  const signIn = useSession((s) => s.signIn);
  const connectWallet = useSession((s) => s.connectWallet);
  const sessionError = useSession((s) => s.error);
  const clearError = useSession((s) => s.clearError);
  const pairingUri = useSession((s) => s.pairingUri);
  const cancelPairing = useSession((s) => s.cancelPairing);
  const resetAll = useSession((s) => s.resetAll);
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

  // Freighter uzantısı kurulu mu? (yalnızca web'de anlamlı)
  const freighter = useQuery({
    queryKey: ['wallet', 'freighter'],
    queryFn: isFreighterAvailable,
    enabled: Platform.OS === 'web',
    staleTime: 30_000,
  });

  /** Cüzdan hazır → SEP-10 ile giriş. SEP-7 yolunda giriş zaten tamamlanmıştır. */
  const finishSignIn = async () => {
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

  /** Web: modal açmadan doğrudan Freighter ile bağlan, ardından SEP-10 girişi. */
  const onConnectFreighter = async () => {
    setBusy(true);
    setError(null);
    clearError();
    try {
      await connectWallet({ walletId: FREIGHTER_WALLET_ID });
      await signIn();
      router.replace('/');
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Web: Wallets Kit modalı (Freighter uzantısı, xBull, Albedo…).
   * Mobil: doğrudan WalletConnect — Freighter mobil yalnızca bu yolu destekliyor
   * (docs.freighter.app/mobile-walletconnect). QR ve "Open in Freighter" düğmesi
   * `WalletConnectSheet` içinde çıkar; cüzdan onaylayınca SEP-10 girişi başlar.
   */
  const onConnect = async () => {
    setError(null);
    clearError();
    if (Platform.OS === 'web') {
      await finishSignIn();
      return;
    }
    setBusy(true);
    try {
      await connectWallet({ mode: 'walletconnect' });
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
    Platform.OS === 'web' ? 'Connect wallet (Freighter, xBull, Albedo…)' : 'Connect Freighter';

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
        {Platform.OS === 'web' && freighter.data ? (
          <>
            <Button
              title="Connect Freighter"
              onPress={onConnectFreighter}
              loading={busy}
              fullWidth
            />
            <Button
              title="Other wallets (xBull, Albedo, Lobstr…)"
              variant="secondary"
              onPress={onConnect}
              fullWidth
            />
          </>
        ) : (
          <Button title={connectLabel} onPress={onConnect} loading={busy} fullWidth />
        )}
        {Platform.OS === 'web' && freighter.isFetched && !freighter.data ? (
          <Button
            title="Install Freighter"
            variant="ghost"
            onPress={() => Linking.openURL('https://www.freighter.app/')}
            fullWidth
          />
        ) : null}
        <Text variant="caption" color="text3">
          {Platform.OS === 'web'
            ? `Set Freighter to ${networkLabel()} before signing in.`
            : `Opens Freighter over WalletConnect. Set it to ${networkLabel()} first.`}
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

      {/* Sıfırdan test: cihazdaki cüzdan ve oturum silinir, bağlanınca yeni adres üretilir. */}
      <Button
        title="Reset app data"
        variant="ghost"
        size="sm"
        onPress={async () => {
          setError(null);
          await resetAll();
          router.replace('/');
        }}
      />

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
