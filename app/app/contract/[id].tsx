import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 9d Sözleşme (node 28:320) — sprint görevi için bkz. SPRINT-1.md */
export default function ContractDetail() {
  return (
    <Screen padded={false}>
      <TopBar title="Contract" />
      <Placeholder
        screen="9d Contract"
        figmaNode="28:320"
        notes="Parties, capital, duration, commission, risk profile, max drawdown; Swipe to approve triggers the escrow contract call (bindings), signature and txApi.submit."
      />
    </Screen>
  );
}
