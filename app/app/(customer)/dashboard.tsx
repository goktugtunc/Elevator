import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 3a Panel · Müşteri (node 30:97) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerDashboard() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Dashboard" />
      <Placeholder
        screen="3a Dashboard · Customer"
        figmaNode="30:97"
        notes="Total portfolio KPI + sparkline, Invested / Open P&amp;L / Investing-Following, Following list, listing interactions."
      />
    </Screen>
  );
}
