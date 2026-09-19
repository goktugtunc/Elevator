import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Field, Text } from '@/components/ui';
import { parseNumberInput } from '@/lib/format';
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
    const commissionPct = parseNumberInput(commission);
    if (commissionPct === null || commissionPct <= 0 || commissionPct > 50)
      next.commission = 'Enter a rate between 0% and 50%.';
    const min = parseNumberInput(returnMin);
    const max = parseNumberInput(returnMax);
    if (min === null) next.returnMin = 'Enter the lower bound.';
    if (max === null) next.returnMax = 'Enter the upper bound.';
    if (min !== null && max !== null && min > max)
      next.returnMax = 'The upper bound cannot be below the lower bound.';
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
      title="Make an offer"
      subtitle={listing?.title}
      footer={<Button title="Send offer" fullWidth loading={submitting} onPress={submit} />}
    >
      <Field
        label="Commission rate"
        value={commission}
        onChangeText={setCommission}
        placeholder="20"
        keyboardType="decimal-pad"
        suffix="%"
        error={errors.commission}
        hint="Your share of the profit — written into the contract."
      />

      <View style={styles.range}>
        <View style={styles.rangeItem}>
          <Field
            label="Expected return (low)"
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
            label="Expected return (high)"
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
        label="Note"
        value={note}
        onChangeText={setNote}
        placeholder="Briefly describe your strategy and risk management."
        multiline
        maxLength={280}
        hint={`${note.trim().length}/280 · optional`}
      />

      {error ? (
        <View style={styles.error}>
          <Text variant="caption" color="loss">
            {error}
          </Text>
        </View>
      ) : null}

      <Text variant="caption" color="text3">
        If the offer is accepted, the contract and escrow are created on-chain. This is not a
        guaranteed return — market risk stays with the customer.
      </Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  range: { flexDirection: 'row', gap: spacing.md },
  rangeItem: { flex: 1 },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
