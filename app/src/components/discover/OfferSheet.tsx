import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Field, Text } from '@/components/ui';
import type { ListingOut, OfferCreateIn } from '@/lib/api/types';
import { formatAmount, formatBps, formatDuration, parseNumberInput } from '@/lib/format';
import { colors, radius, spacing } from '@/theme';

/**
 * "Teklif Ver" bottom sheet — `POST /api/v1/offers` gövdesini toplar.
 * Tutar ve süre ilandan ön-doldurulur; oranlar sunucuya **bps** olarak gider
 * (kullanıcı yüzde girer, 20 → 2000).
 *
 * Form durumu mount ile sıfırlanır: çağıran taraf `key={listing.id}` verir.
 */
export type OfferDraft = OfferCreateIn;

export interface OfferSheetProps {
  listing: ListingOut | null;
  visible: boolean;
  onClose: () => void;
  onSubmit: (draft: OfferDraft) => void;
  submitting?: boolean;
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
  const assetCode = listing?.base_asset?.code ?? '';
  // Ön-doldurma ilan türüne göre ayrışır: sermaye ilanında tutar ve süre
  // ilandan gelir (trader teklif veriyor), hizmet ilanında komisyon trader'ın
  // ilanındaki orandır (müşteri teklif veriyor) — diğerlerini kullanıcı girer.
  const isService = listing?.kind === 'service';
  const [amount, setAmount] = useState(
    isService ? (listing?.min_capital ?? '') : (listing?.amount ?? ''),
  );
  const [duration, setDuration] = useState(
    listing?.duration_days ? String(listing.duration_days) : '',
  );
  const [commission, setCommission] = useState(
    isService && listing?.commission_bps != null ? String(listing.commission_bps / 100) : '',
  );
  const [returnMin, setReturnMin] = useState('');
  const [returnMax, setReturnMax] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    if (!listing) return;
    const next: Record<string, string> = {};

    const amountValue = parseNumberInput(amount);
    if (amountValue === null || amountValue <= 0) next.amount = 'Enter a valid amount.';

    const days = parseNumberInput(duration);
    if (days === null || days < 1) next.duration = 'Enter the duration in days.';

    const commissionPct = parseNumberInput(commission);
    if (commissionPct === null || commissionPct <= 0 || commissionPct > 50)
      next.commission = 'Enter a rate between 0% and 50%.';

    const min = parseNumberInput(returnMin);
    const max = parseNumberInput(returnMax);
    if (min !== null && max !== null && min > max)
      next.returnMax = 'The upper bound cannot be below the lower bound.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSubmit({
      listing_id: listing.id,
      amount: String(amountValue),
      base_asset_id: listing.base_asset_id ?? undefined,
      duration_days: Math.round(days as number),
      commission_bps: Math.round((commissionPct as number) * 100),
      expected_return_min_bps: min === null ? undefined : Math.round(min * 100),
      expected_return_max_bps: max === null ? undefined : Math.round(max * 100),
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
      {listing ? (
        <Text variant="caption" color="text3">
          {isService
            ? `Trader asks ${formatBps(listing.commission_bps)} commission${
                listing.min_capital ? ` · min ${formatAmount(listing.min_capital, assetCode)}` : ''
              }`
            : `Listing asks for ${formatAmount(listing.amount, assetCode)} · ${formatDuration(
                listing.duration_days,
              )}`}
        </Text>
      ) : null}

      <View style={styles.row}>
        <View style={styles.rowItem}>
          <Field
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            placeholder="1000"
            keyboardType="decimal-pad"
            suffix={assetCode}
            error={errors.amount}
          />
        </View>
        <View style={styles.rowItem}>
          <Field
            label="Duration"
            value={duration}
            onChangeText={setDuration}
            placeholder="30"
            keyboardType="number-pad"
            suffix="days"
            error={errors.duration}
          />
        </View>
      </View>

      <Field
        label="Commission rate"
        value={commission}
        onChangeText={setCommission}
        placeholder="20"
        keyboardType="decimal-pad"
        suffix="%"
        error={errors.commission}
        hint="Your share of the profit — written into the agreement."
      />

      <View style={styles.row}>
        <View style={styles.rowItem}>
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
        <View style={styles.rowItem}>
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
        If the offer is accepted, the agreement and escrow are created on-chain. This is not a
        guaranteed return — market risk stays with the customer.
      </Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md },
  rowItem: { flex: 1 },
  error: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
});
