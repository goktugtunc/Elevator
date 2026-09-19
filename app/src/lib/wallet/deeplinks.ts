import { Linking } from 'react-native';

import { WalletError } from './types';
import { debugError, debugLog } from '@/lib/log';

/**
 * WalletConnect eşleşme URI'sini cihazdaki cüzdan uygulamasında açmak.
 *
 * Ham `wc:` URI'si çoğu cüzdanda kayıtlı değildir; her cüzdan kendi şemasını
 * kaydeder. Şemalar WalletConnect kayıt defterinden alındı
 * (`explorer-api.walletconnect.com/v3/wallets`) — tahmin değil:
 *
 *   Freighter → freighterwallet://wc-redirect   (kayıtlı, universal link yok)
 *   LOBSTR    → lobstr:// + https://lobstr.co/uni/wc
 *   xBull     → kayıt defterinde yok; şema tahmini, en sonda denenir
 *
 * Android 11+ `canOpenURL` yalnızca manifest'te tanımlı şemalar için doğru sonuç
 * verir; Expo Go'nun manifest'i bizim şemalarımızı bilmez. Bu yüzden sorgulamak
 * yerine sırayla açmayı deniyoruz ve ilk tutanı kullanıyoruz.
 */
export interface WalletLinkTarget {
  id: string;
  label: string;
  native?: string;
  universal?: string;
  /** Şema WalletConnect kayıt defterinden mi geldi? */
  verified: boolean;
}

export const WC_WALLETS: WalletLinkTarget[] = [
  {
    id: 'freighter',
    label: 'Freighter',
    native: 'freighterwallet://wc-redirect',
    verified: true,
  },
  {
    id: 'lobstr',
    label: 'LOBSTR',
    native: 'lobstr://',
    universal: 'https://lobstr.co/uni/wc',
    verified: true,
  },
  { id: 'xbull', label: 'xBull', native: 'xbull://', verified: false },
];

function withSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/** Aynı cüzdan için denenecek bağlantı biçimleri — yaygın olandan sıra dışına. */
export function pairingLinks(target: WalletLinkTarget, wcUri: string): string[] {
  const encoded = encodeURIComponent(wcUri);
  const links: string[] = [];

  if (target.universal) {
    links.push(`${withSlash(target.universal)}wc?uri=${encoded}`);
    links.push(`${target.universal}?uri=${encoded}`);
  }

  if (target.native) {
    // Web3Modal'ın ürettiği biçim: <scheme>[/path]/wc?uri=…
    links.push(`${withSlash(target.native)}wc?uri=${encoded}`);
    // Yolu olan şemalarda (freighterwallet://wc-redirect) doğrudan parametre
    links.push(`${target.native}?uri=${encoded}`);
    // Kök şema
    const root = `${target.native.split('://')[0]}://`;
    links.push(`${root}wc?uri=${encoded}`);
  }

  // Son çare: ham wc: URI'si (bazı cihazlarda uygulama seçici açılır)
  links.push(wcUri);
  return links;
}

/**
 * Cüzdanı açmayı sırayla dener. Açılan bağlantıyı döner; hiçbiri tutmazsa
 * kullanıcıya gösterilebilecek bir hata fırlatır.
 */
export async function openPairing(target: WalletLinkTarget, wcUri: string): Promise<string> {
  const links = pairingLinks(target, wcUri);
  debugLog('wallet:deeplink', `${target.label} için ${links.length} biçim denenecek`, {
    scheme: target.native ?? target.universal,
    verified: target.verified,
  });
  for (const [i, link] of links.entries()) {
    try {
      await Linking.openURL(link);
      debugLog('wallet:deeplink', `${target.label} AÇILDI (biçim ${i + 1}/${links.length})`, {
        link: link.split('?')[0],
      });
      return link;
    } catch (err) {
      debugError(
        'wallet:deeplink',
        `biçim ${i + 1}/${links.length} reddedildi: ${link.split('?')[0]}`,
        err,
      );
    }
  }
  debugError(
    'wallet:deeplink',
    `${target.label} hiçbir biçimle açılamadı`,
    new Error('no handler'),
  );
  throw new WalletError(
    `Could not open ${target.label}. Is it installed? If not, scan the QR code with a wallet on another device.`,
    'NOT_AVAILABLE',
  );
}
