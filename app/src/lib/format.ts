/**
 * Türkçe sayı/para/yüzde biçimlendirme — Figma'daki gösterimle birebir:
 *   250.000 TL · +8,4% · -%11,2 · 1.250 adet · 312,40
 */
const trNumber = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const trNumber0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

export function formatTRY(amount: number, opts: { decimals?: boolean } = {}): string {
  const n = opts.decimals ? trNumber.format(amount) : trNumber0.format(amount);
  return `${n} TL`;
}

/** +8,4% / -3,1% (işaret önde, yüzde sonda — K/Z için). */
export function formatPnlPct(pct: number, digits = 1): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return `${sign}${Math.abs(pct).toFixed(digits).replace('.', ',')}%`;
}

/** %20 / %15 – %20 (oranlar için yüzde önde). */
export function formatRatePct(pct: number): string {
  return `%${trNumber.format(pct)}`;
}

export function formatRateRange([min, max]: [number, number]): string {
  return `${formatRatePct(min)} – ${formatRatePct(max)}`;
}

export function formatQuantity(qty: number, unit: string): string {
  return `${trNumber.format(qty)} ${unit}`;
}

export function formatPrice(price: number, digits = 2): string {
  return new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

/** "2 dk", "1 sa", "Dün", "12 Eyl" */
export function formatRelative(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'şimdi';
  if (diffMin < 60) return `${diffMin} dk`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} sa`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return 'Dün';
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(d);
}

