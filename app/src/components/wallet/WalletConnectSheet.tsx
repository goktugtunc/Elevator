import * as Clipboard from 'expo-clipboard';
import { Copy, ExternalLink } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { BottomSheet, Button, Text } from '@/components/ui';
import { colors, radius, spacing } from '@/theme';

/**
 * Mobil cüzdan bağlantısı (FE-13) — WalletConnect v2 eşleşme ekranı.
 * Aynı cihazdaki cüzdan için deep link, başka cihaz/masaüstü için QR.
 * Stellar tarafında WalletConnect'i destekleyen cüzdanlar: Lobstr, xBull.
 */
const WALLETS: { id: string; label: string; scheme: (uri: string) => string }[] = [
  {
    id: 'lobstr',
    label: 'Open in Lobstr',
    scheme: (uri) => `lobstr://wc?uri=${encodeURIComponent(uri)}`,
  },
  {
    id: 'xbull',
    label: 'Open in xBull',
    scheme: (uri) => `xbull://wc?uri=${encodeURIComponent(uri)}`,
  },
];

export function WalletConnectSheet({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const openWallet = async (link: string) => {
    setOpenError(null);
    try {
      await Linking.openURL(link);
    } catch {
      setOpenError('No wallet app responded. Install Lobstr or xBull, or scan the QR code.');
    }
  };

  const copyUri = async () => {
    if (!uri) return;
    await Clipboard.setStringAsync(uri);
    setCopied(true);
  };

  return (
    <BottomSheet
      visible={uri !== null}
      onClose={onClose}
      title="Connect your wallet"
      subtitle="Approve the connection request in your Stellar wallet"
      footer={<Button title="Cancel" variant="ghost" fullWidth onPress={onClose} />}
    >
      {uri ? (
        <>
          <View style={styles.qrWrap}>
            <QRCode value={uri} size={200} backgroundColor={colors.surface} color={colors.text} />
          </View>

          <View style={styles.buttons}>
            {WALLETS.map((w) => (
              <Button
                key={w.id}
                title={w.label}
                variant="secondary"
                fullWidth
                leftIcon={<ExternalLink size={16} color={colors.navy900} />}
                onPress={() => openWallet(w.scheme(uri))}
              />
            ))}
            <Button
              title={copied ? 'Link copied' : 'Copy connection link'}
              variant="ghost"
              fullWidth
              leftIcon={<Copy size={16} color={colors.navy900} />}
              onPress={copyUri}
            />
          </View>

          {openError ? (
            <View style={styles.error}>
              <Text variant="caption" color="loss">
                {openError}
              </Text>
            </View>
          ) : null}

          <Text variant="caption" color="text3">
            Scan the code with a wallet on another device, or tap a button above to open a wallet
            installed on this phone. Connecting costs nothing — you only sign a login message.
          </Text>
        </>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  qrWrap: {
    alignSelf: 'center',
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  buttons: { gap: spacing.sm },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
