import { useQuery } from '@tanstack/react-query';
import { Maximize2 } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';

import { Segmented, Text } from '@/components/ui';
import { marketApi } from '@/lib/api';
import type { CandleOut } from '@/lib/api/types';
import { colors, pnlColor, radius, spacing } from '@/theme';

export type Range = '1d' | '1w' | '1m';

const RANGES: { value: Range; label: string }[] = [
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
];

/**
 * Stellar DEX mum grafiği (`GET /market/candles`).
 *
 * Amaç trader'ın rastgele değil grafiğe bakarak hareket etmesi, o yüzden burada
 * eğilim çizgisi değil gerçek OHLC var: gövde açılış–kapanış, fitil gün/saat
 * içi uç değerler. Mumun üstüne dokununca o barın tam değerleri okunur —
 * haftalık/aylık grafikte gün, günlük grafikte saat detayı bu.
 */
export function MarketChart({
  pair = 'XLM-USDC',
  height = 180,
  onExpand,
  initialRange = '1d',
}: {
  pair?: string;
  height?: number;
  /** Verilirse sağ üstte genişletme düğmesi çıkar. */
  onExpand?: (range: Range) => void;
  initialRange?: Range;
}) {
  const [range, setRange] = useState<Range>(initialRange);
  const [picked, setPicked] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  const q = useQuery({
    queryKey: ['market', 'candles', pair, range],
    queryFn: () => marketApi.candles({ pair, range }),
    // Kapanmamış mum sürekli değişiyor; sunucu da kendi içinde önbellekliyor.
    refetchInterval: range === '1d' ? 60_000 : 300_000,
  });

  const candles = q.data?.candles ?? [];
  const shown = picked != null ? candles[picked] : undefined;
  const last = shown ?? candles[candles.length - 1];
  const changeBps = q.data?.change_bps ?? 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <View style={styles.headLeft}>
          <Text variant="captionStrong" color="text2">
            {pair.replace('-', ' / ')}
          </Text>
          {last ? (
            <>
              <Text variant="numericSm">{trim(last.c)}</Text>
              <Text variant="caption" color={pnlColor(changeBps)}>
                {changeBps >= 0 ? '+' : ''}
                {(changeBps / 100).toFixed(2)}%
              </Text>
            </>
          ) : null}
        </View>
        {onExpand ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Expand the chart"
            hitSlop={8}
            onPress={() => onExpand(range)}
          >
            <Maximize2 size={18} color={colors.text3} />
          </Pressable>
        ) : null}
      </View>

      <View
        style={[styles.plot, { height }]}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      >
        {q.isPending ? (
          <Text variant="caption" color="text3">
            Loading the chart…
          </Text>
        ) : q.isError || candles.length === 0 ? (
          <Text variant="caption" color="text3">
            No market data right now.
          </Text>
        ) : (
          <Candles
            candles={candles}
            width={width}
            height={height}
            picked={picked}
            onPick={setPicked}
          />
        )}
      </View>

      {/* Dokunulan mumun tam değerleri; dokunulmadıysa serinin sonu. */}
      {shown ? (
        <View style={styles.readout}>
          <Text variant="caption" color="text3">
            {formatBucket(shown.t, q.data?.interval ?? '1h')}
          </Text>
          <View style={styles.ohlc}>
            <Ohlc label="O" value={shown.o} />
            <Ohlc label="H" value={shown.h} />
            <Ohlc label="L" value={shown.l} />
            <Ohlc label="C" value={shown.c} />
          </View>
        </View>
      ) : null}

      <Segmented
        options={RANGES}
        value={range}
        onChange={(next) => {
          setRange(next);
          setPicked(null);
        }}
      />
    </View>
  );
}

function Candles({
  candles,
  width,
  height,
  picked,
  onPick,
}: {
  candles: CandleOut[];
  width: number;
  height: number;
  picked: number | null;
  onPick: (index: number | null) => void;
}) {
  const geom = useMemo(() => {
    const highs = candles.map((c) => Number(c.h));
    const lows = candles.map((c) => Number(c.l));
    const top = Math.max(...highs);
    const bottom = Math.min(...lows);
    // Düz bir seride bölme sıfıra düşmesin.
    const span = top - bottom || top || 1;
    const pad = span * 0.08;
    return { top: top + pad, bottom: bottom - pad, span: span + pad * 2 };
  }, [candles]);

  if (width <= 0) return null;

  const slot = width / candles.length;
  const body = Math.max(Math.min(slot * 0.62, 14), 1.5);
  const y = (v: number) => height - ((v - geom.bottom) / geom.span) * height;

  const pickAt = (e: GestureResponderEvent) => {
    const i = Math.floor(e.nativeEvent.locationX / slot);
    onPick(i >= 0 && i < candles.length ? i : null);
  };

  return (
    <View
      style={StyleSheet.absoluteFill}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={pickAt}
      onResponderMove={pickAt}
      onResponderRelease={() => onPick(null)}
      onResponderTerminate={() => onPick(null)}
    >
      <Svg width={width} height={height}>
        {candles.map((c, i) => {
          const o = Number(c.o);
          const cl = Number(c.c);
          const up = cl >= o;
          const tone = up ? colors.profit : colors.loss;
          const x = i * slot + slot / 2;
          const yo = y(o);
          const yc = y(cl);
          return (
            <View key={c.t}>
              {/* fitil: bar içindeki en yüksek ve en düşük */}
              <Line x1={x} x2={x} y1={y(Number(c.h))} y2={y(Number(c.l))} stroke={tone} strokeWidth={1} />
              {/* gövde: açılış–kapanış; eşitse görünür kalsın diye en az 1px */}
              <Rect
                x={x - body / 2}
                y={Math.min(yo, yc)}
                width={body}
                height={Math.max(Math.abs(yc - yo), 1)}
                fill={tone}
                rx={1}
              />
            </View>
          );
        })}
        {picked != null ? (
          <Line
            x1={picked * slot + slot / 2}
            x2={picked * slot + slot / 2}
            y1={0}
            y2={height}
            stroke={colors.navy900}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ) : null}
      </Svg>
    </View>
  );
}

function Ohlc({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.ohlcItem}>
      <Text variant="caption" color="text3">
        {label}
      </Text>
      <Text variant="caption">{trim(value)}</Text>
    </View>
  );
}

/** 0.1906912 → "0.19069"; grafikte yedi basamak gürültü. */
function trim(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toFixed(5);
}

/** Mumun kapsadığı zaman aralığını okunur yazar. */
function formatBucket(ms: number, interval: string): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  if (interval === '1d') return day;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, width: '100%' },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headLeft: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flex: 1 },
  plot: {
    width: '100%',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  readout: { gap: 2 },
  ohlc: { flexDirection: 'row', gap: spacing.md },
  ohlcItem: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
});
