import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 5a/5b İşlemler · Trader (node 23:45) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderIslemler() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="İşlemler" />
      <Placeholder
        screen="5a/5b İşlemler · Trader"
        figmaNode="23:45"
        notes="Bugünkü K/Z başlığı, Açık Pozisyonlar / Geçmiş segmented, pozisyon satırları; 'Yeni İşlem' bottom sheet (23:181): Sembol, Yön, Miktar, Fiyat, Not, Yatırımcılara bildir switch."
      />
    </Screen>
  );
}
