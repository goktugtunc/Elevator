import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 6b İlanlarım · Trader (node 26:203) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderListings() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="My Listings" />
      <Placeholder
        screen="6b My Listings · Trader"
        figmaNode="26:203"
        notes="Service listing cards (commission, min capital, requests). Detail goes to /listing/[id] (26:462)."
      />
    </Screen>
  );
}
