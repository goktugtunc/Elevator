import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 8b Profil · Trader (node 27:569) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderProfile() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Profile" />
      <Placeholder
        screen="8b Profile · Trader"
        figmaNode="27:569"
        notes="Same as the customer profile; the menu shows Strategy &amp; commission instead of Risk profile."
      />
    </Screen>
  );
}
