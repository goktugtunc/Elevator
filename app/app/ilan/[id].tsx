import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 6c/6d İlan Detayı (node 26:345) — sprint görevi için bkz. SPRINT-1.md */
export default function IlanDetay() {
  return (
    <Screen padded={false}>
      <TopBar title="İlan Detayı" />
      <Placeholder
        screen="6c/6d İlan Detayı"
        figmaNode="26:345"
        notes="Özet + istatistikler; Teklifler/Talepler ve İlgi sekmeleri. Müşteri (26:345) ve Trader (26:462) varyantları role göre."
      />
    </Screen>
  );
}
