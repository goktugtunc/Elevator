import { useEffect, useState } from 'react';

/**
 * Şu anki zaman damgası — sona erme sayaçları için.
 *
 * `Date.now()` render sırasında çağrılamaz (saf olmayan çağrı, React kuralı);
 * ayrıca ekran açıkken teklifin süresi dolduğunda arayüzün kendiliğinden
 * güncellenmesi gerekir. Bu kanca ikisini birden çözer.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** ISO tarihi geçmiş mi? `now` çağıran taraftan gelir (bkz. useNow). */
export function isPast(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now;
}
