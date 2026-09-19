import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 5c Panel · Trader (node 23:362) — sprint görevi için bkz. SPRINT-1.md */
export default function TraderPanel() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Panel" />
      <Placeholder
        screen="5c Panel · Trader"
        figmaNode="23:362"
        notes="Profilini Güçlendir (progress + checklist), İlanıma Gelen Etkileşimler, Bekleyen Teklifler (StatusChip), Aktif Yatırımcılar (K/Z)."
      />
    </Screen>
  );
}
