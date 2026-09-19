import { Placeholder, Screen, ScreenHeader } from '@/components/layout';
import { SessionActions } from '@/components/wallet';

/** Figma 8a Profil · Müşteri (node 27:436) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerProfile() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Profile" />
      <SessionActions />
      <Placeholder
        screen="8a Profile · Customer"
        figmaNode="27:436"
        notes="Avatar + role pill + short address; menu: Wallet (/wallet), Notification settings, Risk profile, Security, Help &amp; support;"
      />
    </Screen>
  );
}
