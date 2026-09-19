import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Pill, Text } from '@/components/ui';
import { shortAddress } from '@/lib/stellar';
import { useSession } from '@/store/session';
import { spacing } from '@/theme';

/**
 * Profil ekranlarının cüzdan bölümü (8a/8b menüsünün ilk parçası).
 *   Disconnect wallet → oturum kapanır, cüzdan anahtarı cihazda kalır (aynı adresle dönülür).
 *   Reset app data    → anahtar ve onboarding dâhil her şey silinir, bağlanınca yeni adres üretilir.
 */
export function SessionActions() {
  const router = useRouter();
  const address = useSession((s) => s.address);
  const role = useSession((s) => s.role);
  const signOut = useSession((s) => s.signOut);
  const resetAll = useSession((s) => s.resetAll);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      router.replace('/');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="captionStrong" color="text2">
            Wallet address
          </Text>
          <Text variant="numericSm">{address ? shortAddress(address, 6, 6) : 'Not connected'}</Text>
        </View>
        {role ? <Pill label={role === 'trader' ? 'Trader' : 'Customer'} tone="navy" /> : null}
      </View>

      <Button
        title="Disconnect wallet"
        variant="secondary"
        loading={busy}
        fullWidth
        onPress={() => run(signOut)}
      />
      <Button title="Reset app data" variant="danger" fullWidth onPress={() => run(resetAll)} />
      <Text variant="caption" color="text3">
        Reset deletes the in-app wallet key on this device. Back up your secret key first if the
        account holds anything.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.md, marginHorizontal: spacing.lg, marginTop: spacing.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
