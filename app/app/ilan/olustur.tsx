import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 9a İlan Oluştur · Risk Profili (node 28:106) — sprint görevi için bkz. SPRINT-1.md */
export default function IlanOlustur() {
  return (
    <Screen padded={false}>
      <TopBar title="İlan Oluştur" />
      <Placeholder
        screen="9a İlan Oluştur · Risk Profili"
        figmaNode="28:106"
        notes="4 adımlı sihirbaz (2/4 = Risk Profili: Muhafazakâr / Dengeli / Agresif). Son adım listingsApi.create() + zincir üstü ilan kaydı (listing kontratı)."
      />
    </Screen>
  );
}
