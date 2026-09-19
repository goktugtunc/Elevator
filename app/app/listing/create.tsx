import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 9a İlan Oluştur · Risk Profili (node 28:106) — sprint görevi için bkz. SPRINT-1.md */
export default function CreateListing() {
  return (
    <Screen padded={false}>
      <TopBar title="Create Listing" />
      <Placeholder
        screen="9a Create Listing · Risk Profile"
        figmaNode="28:106"
        notes="Four-step wizard (2/4 = risk profile: Conservative / Balanced / Aggressive). Final step calls listingsApi.create() plus the on-chain listing record."
      />
    </Screen>
  );
}
