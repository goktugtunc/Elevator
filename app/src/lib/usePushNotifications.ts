import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { notificationRoute } from '@/lib/notificationRoute';
import { addNotificationListeners, getInitialNotificationData, registerForPush } from '@/lib/push';
import { useSession } from '@/store/session';

/**
 * Push'u oturuma bağlar:
 *   giriş yapıldı → izin iste, token'ı sunucuya kaydet (rol başına bir kez)
 *   bildirime dokunuldu → ilgili ekrana git (liste ekranıyla aynı mantık)
 *
 * Uygulama kapalıyken dokunulan bildirim de karşılanır.
 */
export function usePushNotifications(): void {
  const router = useRouter();
  const status = useSession((s) => s.status);
  const role = useSession((s) => s.role);
  const registeredFor = useRef<string | null>(null);

  // Token kaydı — yalnız girişten sonra; sunucu ucu JWT istiyor.
  useEffect(() => {
    if (status !== 'signed_in') {
      registeredFor.current = null;
      return;
    }
    const key = role ?? 'no-role';
    if (registeredFor.current === key) return;
    registeredFor.current = key;
    void registerForPush();
  }, [status, role]);

  // Bildirime dokunma → yönlendirme.
  useEffect(() => {
    const open = (data: Record<string, unknown> | undefined) => {
      const category = typeof data?.category === 'string' ? data.category : undefined;
      const target = notificationRoute(data, category, role);
      if (target) router.push(target);
    };

    const remove = addNotificationListeners(open);

    // Uygulama bildirimden açıldıysa ilk yanıtı da karşıla.
    let cancelled = false;
    void getInitialNotificationData().then((data) => {
      if (!cancelled && data) open(data);
    });

    return () => {
      cancelled = true;
      remove();
    };
  }, [role, router]);
}
