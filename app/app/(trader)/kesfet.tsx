import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 2b/2d Keşfet · Trader (node 21:160) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderKesfet() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Keşfet" />
      <Placeholder
        screen="2b/2d Keşfet · Trader"
        figmaNode="21:160"
        notes="Kaydırmalı müşteri ilanı kartları: Geç / Kaydet / Teklif Ver. 'Teklif Ver' bottom sheet (21:414): Komisyon Oranı, Tahmini Getiri Aralığı, Not."
      />
    </Screen>
  );
}
