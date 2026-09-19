import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 9d Sözleşme (node 28:320) — sprint görevi için bkz. SPRINT-1.md */
export default function SozlesmeDetay() {
  return (
    <Screen padded={false}>
      <TopBar title="Sözleşme" />
      <Placeholder
        screen="9d Sözleşme"
        figmaNode="28:320"
        notes="Taraflar, Sermaye, Süre, Komisyon, Risk Profili, Azami Düşüş; 'Onaylamak için kaydır' → escrow kontrat çağrısı (bindings) → imza → txApi.submit."
      />
    </Screen>
  );
}
