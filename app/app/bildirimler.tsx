import { Placeholder, Screen, TopBar } from '@/components/layout';

/** Figma 7a/7b/7c Bildirimler (node 27:96) — sprint görevi için bkz. SPRINT-1.md */
export default function Bildirimler() {
  return (
    <Screen padded={false}>
      <TopBar title="Bildirimler" />
      <Placeholder
        screen="7a/7b/7c Bildirimler"
        figmaNode="27:96"
        notes="'Tümünü oku' aksiyonu, filtre chip'leri, Bugün / Dün grupları; boş durum (27:371). Rol fark etmez, veri notificationsApi.list()."
      />
    </Screen>
  );
}
