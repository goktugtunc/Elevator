import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 5c Panel · Trader (node 23:362) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderDashboard() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Dashboard" />
      <Placeholder
        screen="5c Dashboard · Trader"
        figmaNode="23:362"
        notes="Strengthen your profile (progress + checklist), listing interactions, pending offers (StatusChip), active investors (P&amp;L)."
      />
    </Screen>
  );
}
