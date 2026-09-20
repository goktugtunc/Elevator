import { useLocalSearchParams } from 'expo-router';

import { Screen, TopBar } from '@/components/layout';
import { MarketChart, type Range } from '@/components/market';

/**
 * Grafiğin tam ekran hâli. Panelin içinde grafik dar kalıyor; trader mumları
 * tek tek okumak istediğinde buraya geçer. Aralık, geldiği yerdeki seçimle
 * açılır ki bağlam kaybolmasın.
 */
export default function Market() {
  const { pair, range } = useLocalSearchParams<{ pair?: string; range?: string }>();
  const initial = (['1d', '1w', '1m'] as const).find((r) => r === range) ?? '1d';
  return (
    <Screen>
      <TopBar title="Market" />
      <MarketChart pair={pair ?? 'XLM-USDC'} height={420} initialRange={initial as Range} />
    </Screen>
  );
}
