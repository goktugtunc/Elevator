import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * Ekran öne geldiğinde veriyi tazeler.
 *
 * Sekmeler açık kaldığı için tab ekranları yeniden bağlanmıyor; React Query'nin
 * `refetchOnMount` ve `refetchOnWindowFocus` davranışları da bu yüzden hiç
 * tetiklenmiyordu. Sonuç: Keşfet'te bir trader takip edilince panelin takip
 * listesi eski önbellekten okunup boş görünüyordu.
 *
 * Mutasyonlarda `invalidateQueries` çağırmak doğru çözümün yarısı; bu kanca da
 * diğer yarısı — kullanıcı başka bir yoldan veri değiştirdiğinde (ya da ekran
 * uzun süre açık kaldığında) sekmeye dönüş veriyi tazeliyor.
 */
export function useRefetchOnFocus(refetch: () => unknown, enabled = true): void {
  useFocusEffect(
    useCallback(() => {
      if (enabled) void refetch();
    }, [enabled, refetch]),
  );
}
