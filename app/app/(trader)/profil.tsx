import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 8b Profil · Trader (node 27:569) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderProfil() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Profil" />
      <Placeholder
        screen="8b Profil · Trader"
        figmaNode="27:569"
        notes="Müşteri profiliyle aynı; menüde 'Risk Profili' yerine 'Strateji & Komisyon'."
      />
    </Screen>
  );
}
