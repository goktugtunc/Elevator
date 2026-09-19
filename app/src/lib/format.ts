/**
 * Sayı/para/yüzde biçimlendirme. Arayüz dili İngilizce olduğundan yerel ayar
 * en-US; para birimi TRY olarak kalır (ürün TRY anchor ile çalışıyor):
 *   250,000 TRY · +8.4% · -11.2% · 1,250 shares · 312.40
 */
const trNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const trNumber0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatTRY(amount: number, opts: { decimals?: boolean } = {}): string {
  const n = opts.decimals ? trNumber.format(amount) : trNumber0.format(amount);
  return `${n} TRY`;
}

/** +8.4% / -3.1% (işaret önde — K/Z için). */
export function formatPnlPct(pct: number, digits = 1): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

/** 20% / 15% – 20% (oranlar). */
export function formatRatePct(pct: number): string {
  return `${trNumber.format(pct)}%`;
}

export function formatRateRange([min, max]: [number, number]): string {
  return `${formatRatePct(min)} – ${formatRatePct(max)}`;
}

export function formatQuantity(qty: number, unit: string): string {
  return `${trNumber.format(qty)} ${unit}`;
}

export function formatPrice(price: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

/** "2m", "1h", "Yesterday", "Sep 12" */
export function formatRelative(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }).format(d);
}

/**
 * Kullanıcının yazdığı sayıyı (250,000 · 12.5 · 250000) sayıya çevirir.
 * Arayüz İngilizce olduğundan virgül binlik ayırıcı, nokta ondalık ayırıcıdır.
 * Geçersizse null döner — form doğrulaması bunu "zorunlu/geçersiz" olarak gösterir.
 */
export function parseNumberInput(input: string): number | null {
  const cleaned = input.trim().replace(/[\s,]/g, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
