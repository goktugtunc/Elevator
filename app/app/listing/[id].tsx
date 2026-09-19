import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 6c/6d İlan Detayı (node 26:345) — sprint görevi için bkz. SPRINT-1.md */
export default function ListingDetail() {
  return (
    <Screen padded={false}>
      <TopBar title="Listing Detail" />
      <Placeholder
        screen="6c/6d Listing Detail"
        figmaNode="26:345"
        notes="Summary + stats; Offers/Requests and Interest tabs. Customer (26:345) and trader (26:462) variants by role."
      />
    </Screen>
  );
}
