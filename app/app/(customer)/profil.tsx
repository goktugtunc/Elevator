import { Placeholder, Screen, ScreenHeader } from '@/components/layout';

/** Figma 8a Profil · Müşteri (node 27:436) — sprint görevi için bkz. SPRINT-1.md */
export default function CustomerProfil() {
  return (
    <Screen riskStrip={false} padded={false}>
      <ScreenHeader title="Profil" />
      <Placeholder
        screen="8a Profil · Müşteri"
        figmaNode="27:436"
        notes="Avatar + rol pill + kısaltılmış adres; menü: Cüzdan (/cuzdan), Bildirim Ayarları, Risk Profili, Güvenlik, Yardım & Destek; Cüzdan Bağlantısını Kes → session.signOut()."
      />
    </Screen>
  );
}
