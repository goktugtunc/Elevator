import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 3e Trader Profili (node 22:171) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderProfili() {
  return (
    <Screen padded={false}>
      <TopBar title="Trader Profili" />
      <Placeholder
        screen="3e Trader Profili"
        figmaNode="22:171"
        notes="Başlık + pill'ler, KPI grid, Performans (1A/3A/6A/1Y segmented + sparkline), Canlı Hareketler, Açık Pozisyonlar, Son İşlemler, Strateji, Yorumlar. Takip Et / Teklif İste aksiyonları."
      />
    </Screen>
  );
}
