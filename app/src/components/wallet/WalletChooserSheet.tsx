import { ExternalLink, KeyRound, Smartphone, Wallet as WalletIcon } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Field, Text } from '@/components/ui';
import { userMessage } from '@/lib/errors';
import { shortAddress } from '@/lib/stellar';
import { walletConnectAvailable } from '@/lib/wallet';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

/**
 * Mobil cüzdan seçimi (FE-13).
 *   In-app wallet → anahtar cihazda üretilir/saklanır, imza cihazda atılır.
 *   External wallet (SEP-7) → Lobstr/xBull imzalar, imzalı XDR backend'e gider.
 *   WalletConnect → yalnızca proje kimliği tanımlıysa görünür.
 */
type Step = 'menu' | 'import' | 'sep7' | 'waiting';

export function WalletChooserSheet({
  visible,
  onClose,
  onConnected,
}: {
  visible: boolean;
  onClose: () => void;
  /** Cüzdan hazır olduğunda (adres elde edildiğinde) çağrılır. */
  onConnected: () => void;
}) {
  const useLocalWallet = useSession((s) => s.useLocalWallet);
  const importLocalWallet = useSession((s) => s.importLocalWallet);
  const connectWallet = useSession((s) => s.connectWallet);
  const signInWithSep7 = useSession((s) => s.signInWithSep7);

  const [step, setStep] = useState<Step>('menu');
  const [secret, setSecret] = useState('');
  const [sep7Address, setSep7Address] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const reset = () => {
    cancelled.current = true;
    setStep('menu');
    setSecret('');
    setSep7Address('');
    setError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startSep7 = async () => {
    const address = sep7Address.trim();
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
      setError('Enter a valid Stellar address (56 characters, starts with G).');
      return;
    }
    cancelled.current = false;
    setStep('waiting');
    await run(
      () => signInWithSep7(address, () => cancelled.current),
      () => {
        reset();
        onConnected();
      },
    );
    if (!cancelled.current) setStep('sep7');
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={close}
      title={
        step === 'import'
          ? 'Import a secret key'
          : step === 'sep7' || step === 'waiting'
            ? 'Use an external wallet'
            : 'Choose a wallet'
      }
      subtitle={step === 'menu' ? 'Your capital always stays under your own key' : undefined}
      footer={
        step === 'menu' ? null : (
          <Button
            title={step === 'waiting' ? 'Cancel' : 'Back'}
            variant="ghost"
            fullWidth
            onPress={() => {
              cancelled.current = true;
              setError(null);
              setStep(step === 'waiting' ? 'sep7' : 'menu');
            }}
          />
        )
      }
    >
      {step === 'menu' ? (
        <View style={styles.options}>
          <Option
            icon={<Smartphone size={18} color={colors.navy900} />}
            title="In-app wallet"
            body="Create a Stellar key on this device. It is stored in the secure keychain and never leaves the phone. Best for the Testnet demo."
            action={
              <Button
                title="Create / use in-app wallet"
                fullWidth
                loading={busy}
                onPress={() => run(useLocalWallet, onConnected)}
              />
            }
          />
          <Option
            icon={<KeyRound size={18} color={colors.navy900} />}
            title="Import a key"
            body="Already have a Testnet secret key? Bring it in and sign with it."
            action={
              <Button
                title="Import secret key"
                variant="secondary"
                fullWidth
                onPress={() => setStep('import')}
              />
            }
          />
          <Option
            icon={<ExternalLink size={18} color={colors.navy900} />}
            title="External wallet (Lobstr, xBull)"
            body="Sign in your own wallet app over SEP-7. The signature goes straight to our server — no third-party service in between."
            action={
              <Button
                title="Use external wallet"
                variant="secondary"
                fullWidth
                onPress={() => setStep('sep7')}
              />
            }
          />
          {walletConnectAvailable() ? (
            <Option
              icon={<WalletIcon size={18} color={colors.navy900} />}
              title="WalletConnect"
              body="Pair with a wallet over WalletConnect v2."
              action={
                <Button
                  title="Connect over WalletConnect"
                  variant="secondary"
                  fullWidth
                  onPress={() => run(() => connectWallet('walletconnect'), onConnected)}
                />
              }
            />
          ) : null}
        </View>
      ) : null}

      {step === 'import' ? (
        <>
          <Field
            label="Secret key"
            value={secret}
            onChangeText={setSecret}
            placeholder="S…"
            autoCapitalize="characters"
            autoCorrect={false}
            secureTextEntry
            hint="Testnet keys only. It is stored in this device's secure keychain."
          />
          <Button
            title="Import and continue"
            fullWidth
            loading={busy}
            onPress={() => run(() => importLocalWallet(secret), onConnected)}
          />
        </>
      ) : null}

      {step === 'sep7' ? (
        <>
          <Field
            label="Your wallet address"
            value={sep7Address}
            onChangeText={setSep7Address}
            placeholder="G…"
            autoCapitalize="characters"
            autoCorrect={false}
            hint="Copy it from Lobstr or xBull. We need it to build the sign-in challenge."
          />
          <Button title="Open wallet to sign" fullWidth loading={busy} onPress={startSep7} />
          <Text variant="caption" color="text3">
            Your wallet opens with a SEP-7 request, signs the challenge and sends it to
            traderkirala’s own server. Make sure the wallet is on Testnet.
          </Text>
        </>
      ) : null}

      {step === 'waiting' ? (
        <View style={styles.waiting}>
          <ActivityIndicator color={colors.navy900} />
          <Text variant="bodyStrong">Waiting for your signature…</Text>
          <Text variant="caption" color="text2" align="center">
            Approve the request in {shortAddress(sep7Address.trim(), 4, 4)}’s wallet, then come back
            to this screen. This can take up to three minutes.
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.error}>
          <Text variant="caption" color="loss">
            {error}
          </Text>
        </View>
      ) : null}
    </BottomSheet>
  );
}

function Option({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <View style={styles.option}>
      <View style={styles.optionHead}>
        <View style={styles.iconTile}>{icon}</View>
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          {title}
        </Text>
      </View>
      <Text variant="caption" color="text2">
        {body}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  options: { gap: spacing.lg },
  option: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconTile: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.navy050,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waiting: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
