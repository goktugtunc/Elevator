import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 9b Mesajlar (node 28:171) — sprint görevi için bkz. SPRINT-1.md */
export default function MesajlarIndex() {
  return (
    <Screen padded={false}>
      <TopBar title="Mesajlar" />
      <Placeholder
        screen="9b Mesajlar"
        figmaNode="28:171"
        notes="Thread listesi (avatar, son mesaj, zaman, okunmamış sayacı). messagesApi.threads()."
      />
    </Screen>
  );
}
