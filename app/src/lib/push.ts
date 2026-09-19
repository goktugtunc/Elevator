import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
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
 */

/** Uygulama önplandayken de bildirim görünsün (varsayılan: gösterme). */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** EAS proje kimliği — iki farklı yerde durabiliyor (klasik / yeni yapılandırma). */
function easProjectId(): string | null {
  const fromExpoConfig = Constants.expoConfig?.extra?.eas?.projectId;
  const fromEasConfig = (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  const id = fromExpoConfig ?? fromEasConfig;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Android'de bildirimlerin görünmesi için bir kanal şart. */
async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'TraderKirala',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: colors.navy900,
  });
}

export type PushSkipReason =
  | 'simulator'
  | 'permission_denied'
  | 'no_project_id'
  | 'expo_go_android'
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

    await ensureAndroidChannel();

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
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

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
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
  try {
    await notificationsApi.setPushToken('');
    debugLog('push', 'token sunucudan silindi');
  } catch (err) {
    debugError('push', 'token silinemedi', err);
  }
}

/** Uygulama açıkken gelen bildirimler + dokunma olayları için dinleyiciler. */
export function addNotificationListeners(onOpen: (response: Notifications.NotificationResponse) => void) {
  const responseSub = Notifications.addNotificationResponseReceivedListener(onOpen);
  return () => {
    responseSub.remove();
  };
}

/** Uygulama kapalıyken bildirime dokunulup açıldıysa o yanıtı verir. */
export async function getInitialNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  try {
    return await Notifications.getLastNotificationResponseAsync();
  } catch {
    return null;
  }
}
