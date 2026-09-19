import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 3a Panel · Müşteri (node 30:97) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerPanel() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Panel" />
      <Placeholder
        screen="3a Panel · Müşteri"
        figmaNode="30:97"
        notes="Toplam Portföy KPI + sparkline, Yatırılan / Açık K/Z / Yatırımda-Takipte, Takip Ettiklerim listesi, İlanıma Gelen Etkileşimler."
      />
    </Screen>
  );
}
