import { useLocalSearchParams } from 'expo-router';

import { Placeholder, Screen, TopBar } from '@/components/layout';
import type { Role } from '@/types';

/**
 * Figma 1f · Kayıt · Bilgiler (Müşteri) — node 19:269
 * Figma 1g · Kayıt · Bilgiler (Trader)  — node 19:353
 * Adım 2/2. Sprint görevi FE-03.
 */
export default function RegisterDetails() {
  const { role } = useLocalSearchParams<{ role: Role }>();
  const isTrader = role === 'trader';
  return (
    <Screen padded={false}>
      <TopBar title={`Kayıt Ol · ${isTrader ? 'Trader' : 'Müşteri'}`} />
      <Placeholder
        screen={isTrader ? '1g · Kayıt · Bilgiler (Trader)' : '1f · Kayıt · Bilgiler (Müşteri)'}
        figmaNode={isTrader ? '19:353' : '19:269'}
        notes={
          isTrader
            ? 'Alanlar: Kullanıcı Adı, Uzman Olduğun Piyasalar (chip), Strateji Özeti, Komisyon Oranı, Min. Sermaye. Cüzdan adresi salt-okunur gösterilir.'
            : 'Alanlar: Kullanıcı Adı, Yatırım Bütçesi (TL), Risk Tercihi (chip), İlgilendiğin Piyasalar (chip). Cüzdan adresi salt-okunur gösterilir.'
        }
      />
    </Screen>
  );
}
