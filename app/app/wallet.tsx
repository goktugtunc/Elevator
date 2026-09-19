import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 8c Cüzdan (node 27:699) — sprint görevi için bkz. SPRINT-1.md */
export default function WalletScreen() {
  return (
    <Screen padded={false}>
      <TopBar title="Wallet" />
      <Placeholder
        screen="8c Wallet"
        figmaNode="27:699"
        notes="Total balance (Horizon balances, TRY asset), address + Connected, Deposit TRY / Withdraw via anchorApi (SEP-24 interactive URL, expo-web-browser), recent transactions."
      />
    </Screen>
  );
}
