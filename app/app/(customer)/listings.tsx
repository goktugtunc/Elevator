import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 6a İlanlarım · Müşteri (node 26:58) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerListings() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="My Listings" />
      <Placeholder
        screen="6a My Listings · Customer"
        figmaNode="26:58"
        notes="Active / Pending / Closed segmented; listing card (capital listing, stats, recent interactions). Detail goes to /listing/[id] (26:345)."
      />
    </Screen>
  );
}
