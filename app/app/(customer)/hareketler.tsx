import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 3b–3d Hareketler (node 30:252) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerHareketler() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Hareketler" />
      <Placeholder
        screen="3b–3d Hareketler"
        figmaNode="30:252"
        notes="Trader filtre chip'leri, canlı akış satırları (ListRow), Birleşik / Trader bazlı görünüm, 'Görünümü Düzenle' bottom sheet (30:536)."
      />
    </Screen>
  );
}
