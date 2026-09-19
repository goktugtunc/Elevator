import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Field, Text } from '@/components/ui';
import { parseTRNumber } from '@/lib/format';
import { colors, radius, spacing } from '@/theme';
import type { Listing } from '@/types';

/**
 * Figma 2d · "Teklif Ver" bottom sheet (node 21:414) — FE-06.
 * Trader, müşterinin sermaye ilanına komisyon oranı, tahmini getiri aralığı ve
 * not ile teklif verir. Gönderim `POST /listings/:id/offers` (BE-03).
 * Form durumu mount ile sıfırlanır: çağıran taraf `key={listing.id}` verir.
 */
export interface OfferDraft {
  commissionPct: number;
  expectedReturnRange: [number, number];
  note?: string;
}

export interface OfferSheetProps {
  listing: Listing | null;
  visible: boolean;
  onClose: () => void;
  onSubmit: (draft: OfferDraft) => void;
  submitting?: boolean;
  /** Sunucudan dönen hata (teklif gönderilemediğinde sheet açık kalır). */
  error?: string | null;
}

export function OfferSheet({
  listing,
  visible,
  onClose,
  onSubmit,
  submitting,
  error,
}: OfferSheetProps) {
  const [commission, setCommission] = useState('');
  const [returnMin, setReturnMin] = useState('');
  const [returnMax, setReturnMax] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const next: Record<string, string> = {};
    const commissionPct = parseTRNumber(commission);
    if (commissionPct === null || commissionPct <= 0 || commissionPct > 50)
      next.commission = '%0 ile %50 arasında bir oran gir.';
    const min = parseTRNumber(returnMin);
    const max = parseTRNumber(returnMax);
    if (min === null) next.returnMin = 'Alt sınırı gir.';
    if (max === null) next.returnMax = 'Üst sınırı gir.';
    if (min !== null && max !== null && min > max)
      next.returnMax = 'Üst sınır alt sınırdan küçük olamaz.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({
      commissionPct: commissionPct as number,
      expectedReturnRange: [min as number, max as number],
      note: note.trim() || undefined,
    });
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Teklif Ver"
      subtitle={listing?.title}
      footer={<Button title="Teklifi Gönder" fullWidth loading={submitting} onPress={submit} />}
    >
      <Field
        label="Komisyon Oranı"
        value={commission}
        onChangeText={setCommission}
        placeholder="20"
        keyboardType="decimal-pad"
        suffix="%"
        error={errors.commission}
        hint="Kârdan alacağın pay; sözleşmeye bu oran yazılır."
      />

      <View style={styles.range}>
        <View style={styles.rangeItem}>
          <Field
            label="Tahmini Getiri (alt)"
            value={returnMin}
            onChangeText={setReturnMin}
            placeholder="15"
            keyboardType="decimal-pad"
            suffix="%"
            error={errors.returnMin}
          />
        </View>
        <View style={styles.rangeItem}>
          <Field
            label="Tahmini Getiri (üst)"
            value={returnMax}
            onChangeText={setReturnMax}
            placeholder="25"
            keyboardType="decimal-pad"
            suffix="%"
            error={errors.returnMax}
          />
        </View>
      </View>

      <Field
        label="Not"
        value={note}
        onChangeText={setNote}
        placeholder="Stratejini ve risk yönetimini kısaca anlat."
        multiline
        maxLength={280}
        hint={`${note.trim().length}/280 · isteğe bağlı`}
      />

      {error ? (
        <View style={styles.error}>
          <Text variant="caption" color="loss">
            {error}
          </Text>
        </View>
      ) : null}

      <Text variant="caption" color="text3">
        Teklif kabul edilirse sözleşme ve escrow zincir üstünde oluşturulur; getiri taahhüdü
        değildir, piyasa riski müşteriye aittir.
      </Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  range: { flexDirection: 'row', gap: spacing.md },
  rangeItem: { flex: 1 },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
