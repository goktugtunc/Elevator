import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 6b İlanlarım · Trader (node 26:203) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderIlanlarim() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="İlanlarım" />
      <Placeholder
        screen="6b İlanlarım · Trader"
        figmaNode="26:203"
        notes="Hizmet ilanı kartları (komisyon, min sermaye, talepler). Detay → /ilan/[id] (26:462)."
      />
    </Screen>
  );
}
