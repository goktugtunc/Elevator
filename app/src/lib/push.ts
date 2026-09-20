import Constants from 'expo-constants';
import * as Device from 'expo-device';
import type * as NotificationsModule from 'expo-notifications';
import { Platform } from 'react-native';

import { notificationsApi } from '@/lib/api';
import { debugError, debugLog } from '@/lib/log';
import { colors } from '@/theme';

/**
 * Expo push bildirimleri (FE-19).
 *
 * Sunucu tarafı hazır: olaylar `notifications` satırı üretiyor, worker'ın `push`
 * işi bunları Expo Push API'ye gönderiyor (`EXPO_PUSH_ENABLED=true`). İstemcinin
 * tek görevi cihaz token'ını `PUT /notifications/push-token` ile kaydetmek.
 *
 * **İki sert kısıt var, ikisi de kod değil kurulum meselesi:**
 *
 * 1. `getExpoPushTokenAsync` bir EAS `projectId` ister. Proje henüz EAS'e
 *    bağlanmadı (`app.json → extra.eas.projectId` yok). Kimlik yokken token
 *    alınamaz; bu durumda sessizce atlanır, uygulama çalışmaya devam eder.
 * 2. Android'de **Expo Go uzaktan bildirimi desteklemiyor** (SDK 53'ten beri);
 *    derlenmiş build gerekir. iOS'ta Expo Go çalışır.
 *
 * Kurulum tamamlandığında burada değişiklik gerekmez — kimlik göründüğü anda
 * kayıt kendiliğinden çalışır.
 *
 * **Modül tembel yüklenir.** `expo-notifications` Android'de Expo Go altında
 * *import anında* hata fırlatıyor; statik import bu dosyayı içe alan her şeyi
 * (session store → tüm uygulama) çökertiyordu. Bu yüzden modül yalnızca
 * gerçekten kullanılabilir olduğunda require ediliyor.
 */

type Notifications = typeof NotificationsModule;

/** Expo Go'da mıyız? (SDK 50+: storeClient) */
function isExpoGo(): boolean {
  return Constants.executionEnvironment === 'storeClient';
}

/** Uzaktan bildirim bu ortamda mümkün mü? */
function remotePushSupported(): boolean {
  // Android + Expo Go = desteklenmiyor (SDK 53'ten beri). iOS'ta Expo Go çalışır.
  return !(Platform.OS === 'android' && isExpoGo());
}

let cached: Notifications | null | undefined;

function loadNotifications(): Notifications | null {
  if (cached !== undefined) return cached;
  if (!remotePushSupported()) {
    cached = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications') as Notifications;
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    cached = mod;
  } catch (err) {
    debugError('push', 'expo-notifications yüklenemedi', err);
    cached = null;
  }
  return cached;
}

/** EAS proje kimliği — iki farklı yerde durabiliyor (klasik / yeni yapılandırma). */
function easProjectId(): string | null {
  const fromExpoConfig = Constants.expoConfig?.extra?.eas?.projectId;
  const fromEasConfig = (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  const id = fromExpoConfig ?? fromEasConfig;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Android'de bildirimlerin görünmesi için bir kanal şart. */
async function ensureAndroidChannel(n: Notifications): Promise<void> {
  if (Platform.OS !== 'android') return;
  await n.setNotificationChannelAsync('default', {
    name: 'Elevator',
    importance: n.AndroidImportance.DEFAULT,
    lightColor: colors.navy900,
  });
}

export type PushSkipReason =
  | 'simulator'
  | 'unsupported'
  | 'permission_denied'
  | 'no_project_id'
  | 'error';

export interface PushRegistration {
  token: string | null;
  skipped: PushSkipReason | null;
}

/**
 * İzin ister, token alır ve sunucuya kaydeder.
 * Hiçbir koşulda hata fırlatmaz — push olmadan da uygulama tam çalışır.
 */
export async function registerForPush(): Promise<PushRegistration> {
  try {
    if (!Device.isDevice) {
      debugLog('push', 'simülatörde push yok, atlandı');
      return { token: null, skipped: 'simulator' };
    }

    const n = loadNotifications();
    if (!n) {
      debugLog('push', 'bu ortamda uzaktan bildirim yok (Android + Expo Go), atlandı');
      return { token: null, skipped: 'unsupported' };
    }

    await ensureAndroidChannel(n);

    const existing = await n.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await n.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') {
      debugLog('push', 'bildirim izni verilmedi');
      return { token: null, skipped: 'permission_denied' };
    }

    const projectId = easProjectId();
    if (!projectId) {
      debugLog('push', 'EAS projectId yok — token alınamaz (eas init gerekiyor)');
      return { token: null, skipped: 'no_project_id' };
    }

    const { data: token } = await n.getExpoPushTokenAsync({ projectId });
    await notificationsApi.setPushToken(token);
    debugLog('push', 'token sunucuya kaydedildi', { token: `${token.slice(0, 22)}…` });
    return { token, skipped: null };
  } catch (err) {
    // Android/Expo Go burada patlar; kullanıcıya yansıtmaya değmez.
    debugError('push', 'kayıt başarısız', err);
    return { token: null, skipped: 'error' };
  }
}

/** Çıkışta sunucudaki token'ı düşür ki bu cihaza bildirim gitmesin. */
export async function unregisterPush(): Promise<void> {
  if (!remotePushSupported()) return;
  try {
    await notificationsApi.setPushToken('');
    debugLog('push', 'token sunucudan silindi');
  } catch (err) {
    debugError('push', 'token silinemedi', err);
  }
}

/** Bildirime dokunma dinleyicisi. Desteklenmeyen ortamda sessizce hiçbir şey yapmaz. */
export function addNotificationListeners(
  onOpen: (data: Record<string, unknown> | undefined) => void,
): () => void {
  const n = loadNotifications();
  if (!n) return () => undefined;
  const sub = n.addNotificationResponseReceivedListener((response) => {
    onOpen(response.notification.request.content.data as Record<string, unknown> | undefined);
  });
  return () => sub.remove();
}

/** Uygulama kapalıyken bildirime dokunulup açıldıysa o bildirimin verisi. */
export async function getInitialNotificationData(): Promise<Record<string, unknown> | undefined> {
  const n = loadNotifications();
  if (!n) return undefined;
  try {
    const response = await n.getLastNotificationResponseAsync();
    return response?.notification.request.content.data as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}
