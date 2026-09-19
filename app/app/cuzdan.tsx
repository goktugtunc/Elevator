import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 8c Cüzdan (node 27:699) — sprint görevi için bkz. SPRINT-1.md */
export default function Cuzdan() {
  return (
    <Screen padded={false}>
      <TopBar title="Cüzdan" />
      <Placeholder
        screen="8c Cüzdan"
        figmaNode="27:699"
        notes="Toplam Bakiye (Horizon balances → TRY varlığı), adres + Bağlı, 'TRY Yatır' / 'Çek' → anchorApi (SEP-24 interactive URL, expo-web-browser), Son İşlemler listesi."
      />
    </Screen>
  );
}
