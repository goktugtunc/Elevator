import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 9c Sohbet (node 28:266) — sprint görevi için bkz. SPRINT-1.md */
export default function MesajlarThread() {
  return (
    <Screen padded={false}>
      <TopBar title="Sohbet" />
      <Placeholder
        screen="9c Sohbet"
        figmaNode="28:266"
        notes="Balonlu mesaj akışı, 'Mesaj yaz…' alanı. Sözleşme önerisi → /sozlesme/[id]."
      />
    </Screen>
  );
}
