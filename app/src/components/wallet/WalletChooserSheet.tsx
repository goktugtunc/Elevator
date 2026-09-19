import { KeyRound, Smartphone, Wallet as WalletIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Field, Text } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { walletConnectAvailable } from '@/lib/wallet';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

type Step = 'menu' | 'import';

/**
 * Mobil cüzdan seçimi (FE-13) — giriş ekranının "Connect wallet" düğmesi bunu açar.
 *
 * Üç yol vardır ve ilki hiçbir dış servise bağlı değildir:
 *   1. Uygulama içi cüzdan — anahtar cihazda üretilir, güvenli depoda kalır,
 *      imza cihazda atılır.
 *   2. Anahtar içe aktarma — elindeki Testnet gizli anahtarı (S…).
 *   3. WalletConnect — Freighter, LOBSTR, xBull. **Yalnızca proje kimliği
 *      tanımlıysa çalışır**; Freighter mobil yalnızca bu yolu destekler
 *      (docs.freighter.app/mobile-walletconnect).
 *
 * Kimlik tanımlı değilse üçüncü seçenek gizlenmez, sebebiyle birlikte devre dışı
 * gösterilir — kullanıcı neyin eksik olduğunu görsün, çıkmaza girmesin.
 */
export function WalletChooserSheet({
  visible,
  onClose,
  onConnected,
}: {
  visible: boolean;
  onClose: () => void;
  /** Cüzdan hazır (adres elde edildi) — çağıran taraf SEP-10 girişini başlatır. */
  onConnected: () => void;
}) {
  const connectWallet = useSession((s) => s.connectWallet);
  const importWallet = useSession((s) => s.importWallet);

  const [step, setStep] = useState<Step>('menu');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wcReady = walletConnectAvailable();

  const close = () => {
    setStep('menu');
    setSecret('');
    setError(null);
    setBusy(null);
    onClose();
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setStep('menu');
      setSecret('');
      onConnected();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={close}
      title={step === 'import' ? 'Import a secret key' : 'Set up your wallet'}
      subtitle={
        step === 'import'
          ? 'The key is stored in this device’s secure storage and never leaves it.'
          : 'Signing in asks your wallet to sign a SEP-10 challenge. It is free and moves no funds.'
      }
    >
      {step === 'import' ? (
        <View style={styles.body}>
          <Field
            label="Secret key"
            value={secret}
            onChangeText={setSecret}
            placeholder="S…"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            hint="Use a Testnet key. Never paste a key that holds real funds."
          />
          {error ? (
            <View style={styles.errorBox}>
              <Text variant="caption" color="loss">
                {error}
              </Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Button title="Back" variant="secondary" onPress={() => setStep('menu')} />
            <View style={{ flex: 1 }} />
            <Button
              title="Import"
              disabled={secret.trim().length === 0}
              loading={busy === 'import'}
              onPress={() => run('import', () => importWallet(secret))}
            />
          </View>
        </View>
      ) : (
        <View style={styles.body}>
          <Option
            icon={<WalletIcon size={20} color={colors.navy900} />}
            title="In-app wallet"
            body="Creates a key on this device and keeps it in secure storage. No other app needed — the most reliable option."
            busy={busy === 'local'}
            onPress={() => run('local', () => connectWallet({ mode: 'local' }))}
          />
          <Option
            icon={<KeyRound size={20} color={colors.navy900} />}
            title="Import a key"
            body="Already have a Testnet secret key? Bring it in."
            onPress={() => {
              setError(null);
              setStep('import');
            }}
          />
          <Option
            icon={<Smartphone size={20} color={colors.navy900} />}
            title="Freighter, LOBSTR or xBull"
            body={
              wcReady
                ? 'Connects over WalletConnect. Scan the QR or open the wallet app to approve.'
                : 'Needs a WalletConnect project ID (EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID). Freighter mobile supports only this path.'
            }
            disabled={!wcReady}
            busy={busy === 'walletconnect'}
            onPress={() => run('walletconnect', () => connectWallet({ mode: 'walletconnect' }))}
          />
          {error ? (
            <View style={styles.errorBox}>
              <Text variant="caption" color="loss">
                {error}
              </Text>
            </View>
          ) : null}
        </View>
      )}
    </BottomSheet>
  );
}

function Option({
  icon,
  title,
  body,
  onPress,
  busy,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        disabled && styles.optionDisabled,
        pressed && !disabled && styles.optionPressed,
      ]}
    >
      <View style={styles.optionIcon}>{icon}</View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{title}</Text>
        <Text variant="caption" color="text2">
          {body}
        </Text>
      </View>
      {busy ? (
        <Text variant="caption" color="text3">
          …
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  optionPressed: { borderColor: colors.navy900 },
  optionDisabled: { opacity: 0.55, backgroundColor: colors.surfaceAlt },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.navy050,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  errorBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
