import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 6a İlanlarım · Müşteri (node 26:58) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerIlanlarim() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="İlanlarım" />
      <Placeholder
        screen="6a İlanlarım · Müşteri"
        figmaNode="26:58"
        notes="Aktif / Bekleyen / Kapalı segmented; İlan Kartı (sermaye ilanı, istatistikler, son etkileşimler). Detay → /ilan/[id] (26:345)."
      />
    </Screen>
  );
}
