import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 2a/2c Keşfet · Müşteri (node 21:30) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerKesfet() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Keşfet" />
      <Placeholder
        screen="2a/2c Keşfet · Müşteri"
        figmaNode="21:30"
        notes="Kaydırmalı trader kartları (Swipe Card): Geç / Takip Et / Teklif İste. Sağa kaydırma = Teklif İste (21:282). react-native-gesture-handler + reanimated."
      />
    </Screen>
  );
}
