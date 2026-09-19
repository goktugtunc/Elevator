import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen, TopBar } from '@/components/layout';
import { Button, Card, Chip, ErrorNotice, Field, Progress, Text } from '@/components/ui';
import { listingsApi, metaApi } from '@/lib/api';
import type {
  ListingCreateIn,
  MarketCategory,
  RiskProfile,
  UserRole,
} from '@/lib/api/types';
import { formatAmount, parseNumberInput } from '@/lib/format';
import { useSession } from '@/store/session';
import { colors, radius, spacing } from '@/theme';

const MARKETS: { value: MarketCategory; label: string }[] = [
  { value: 'crypto', label: 'Crypto' },
  { value: 'stable_fx', label: 'Stable / FX' },
  { value: 'defi', label: 'DeFi' },
];

const RISK_PROFILES: { value: RiskProfile; label: string }[] = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'aggressive', label: 'Aggressive' },
];

type Errors = Partial<Record<string, string>>;

/**
 * Figma 6e · İlan Oluştur sihirbazı (node 28:106) — `POST /listings`.
 * Dört adım: temel bilgiler → piyasa & risk → koşullar → önizleme.
 * İlan türü rolden gelir: trader hizmet, müşteri sermaye ilanı yayımlar.
 */
export default function CreateListing() {
  const router = useRouter();
  const qc = useQueryClient();
  const role = useSession((s) => s.role) as UserRole | null;
  const isTrader = role === 'trader';

  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Errors>({});

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [markets, setMarkets] = useState<MarketCategory[]>([]);
  const [riskProfile, setRiskProfile] = useState<RiskProfile | null>(null);
  const [amount, setAmount] = useState('');
  const [minCapital, setMinCapital] = useState('');
  const [commission, setCommission] = useState('');
  const [durationDays, setDurationDays] = useState('');
  const [maxLoss, setMaxLoss] = useState('');
  const [returnMin, setReturnMin] = useState('');
  const [returnMax, setReturnMax] = useState('');

  // Sunucu temel varlığı kendisi seçebilir; yine de listeden ilkini öneririz.
  const assets = useQuery({ queryKey: ['assets', 'base'], queryFn: () => metaApi.assets({ base_only: true }) });
  const baseAsset = assets.data?.[0];

  const create = useMutation({
    mutationFn: (payload: ListingCreateIn) => listingsApi.create(payload),
    onSuccess: (listing) => {
      void qc.invalidateQueries({ queryKey: ['listings'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      router.replace(`/listing/${listing.id}`);
    },
  });

  const validateStep = (index: number): Errors => {
    const next: Errors = {};
    if (index === 0) {
      if (title.trim().length < 5) next.title = 'Use at least 5 characters.';
      else if (title.trim().length > 80) next.title = 'Use at most 80 characters.';
      if (description.trim().length < 20)
        next.description = 'Describe the offer in at least 20 characters.';
    }
    if (index === 1) {
      if (markets.length === 0) next.markets = 'Pick at least one market.';
      if (!riskProfile) next.riskProfile = 'Choose a risk profile.';
    }
    if (index === 2) {
      const duration = parseNumberInput(durationDays);
      if (duration === null || duration <= 0) next.durationDays = 'Enter a duration in days.';
      const loss = parseNumberInput(maxLoss);
      if (loss === null || loss <= 0 || loss >= 100) next.maxLoss = 'Enter a value between 0 and 100.';
      if (isTrader) {
        const pct = parseNumberInput(commission);
        if (pct === null || pct <= 0 || pct > 50) next.commission = 'Enter a rate between 0% and 50%.';
        const min = parseNumberInput(minCapital);
        if (min === null || min <= 0) next.minCapital = 'Enter a valid amount.';
        const lo = parseNumberInput(returnMin);
        const hi = parseNumberInput(returnMax);
        if (lo !== null && hi !== null && lo > hi)
          next.returnRange = 'The lower bound must not exceed the upper bound.';
      } else {
        const value = parseNumberInput(amount);
        if (value === null || value <= 0) next.amount = 'Enter the capital you want to allocate.';
      }
    }
    return next;
  };

  const payload = useMemo((): ListingCreateIn => {
    const duration = parseNumberInput(durationDays);
    const loss = parseNumberInput(maxLoss);
    const base: ListingCreateIn = {
      kind: isTrader ? 'service' : 'capital',
      title: title.trim(),
      description: description.trim(),
      markets,
      risk_profile: riskProfile,
      base_asset_id: baseAsset?.id ?? null,
      duration_days: duration ?? null,
      max_loss_bps: loss !== null ? Math.round(loss * 100) : null,
    };
    if (isTrader) {
      const pct = parseNumberInput(commission);
      const min = parseNumberInput(minCapital);
      const lo = parseNumberInput(returnMin);
      const hi = parseNumberInput(returnMax);
      return {
        ...base,
        commission_bps: pct !== null ? Math.round(pct * 100) : null,
        min_capital: min !== null ? String(min) : null,
        expected_return_min_bps: lo !== null ? Math.round(lo * 100) : null,
        expected_return_max_bps: hi !== null ? Math.round(hi * 100) : null,
      };
    }
    const value = parseNumberInput(amount);
    return { ...base, amount: value !== null ? String(value) : null };
  }, [
    isTrader, title, description, markets, riskProfile, baseAsset, durationDays,
    maxLoss, commission, minCapital, returnMin, returnMax, amount,
  ]);

  const steps = ['Basics', 'Market & risk', 'Terms', 'Review'];

  const goNext = () => {
    const found = validateStep(step);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  const toggleMarket = (m: MarketCategory) =>
    setMarkets((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : prev.length >= 3 ? prev : [...prev, m],
    );

  const assetCode = baseAsset?.code ?? '';

  return (
    <Screen padded={false}>
      <TopBar
        title={isTrader ? 'New service listing' : 'New capital listing'}
        onBack={step === 0 ? undefined : () => setStep((s) => s - 1)}
      />
      <View style={styles.body}>
        <Progress
          value={(step + 1) / steps.length}
          label={`Step ${step + 1} of ${steps.length} · ${steps[step]}`}
        />

        {step === 0 ? (
          <>
            <Field
              label="Title"
              value={title}
              onChangeText={setTitle}
              placeholder={isTrader ? 'e.g. Balanced BTC/ETH swing strategy' : 'e.g. 50k for a balanced trader'}
              maxLength={80}
              error={errors.title}
              hint="This is the headline on the swipe card."
            />
            <Field
              label="Description"
              value={description}
              onChangeText={setDescription}
              placeholder={
                isTrader
                  ? 'How you trade, what time horizon, how you manage risk.'
                  : 'What you expect from a trader and how hands-on you want to be.'
              }
              multiline
              maxLength={600}
              error={errors.description}
              hint={`${description.trim().length}/600`}
            />
          </>
        ) : null}

        {step === 1 ? (
          <>
            <ChipGroup
              label="Markets"
              hint="Pick up to three."
              error={errors.markets}
              options={MARKETS.map((m) => ({
                key: m.value,
                label: m.label,
                active: markets.includes(m.value),
              }))}
              onToggle={(k) => toggleMarket(k as MarketCategory)}
            />
            <ChipGroup
              label="Risk profile"
              hint="Shown as a badge on your listing."
              error={errors.riskProfile}
              options={RISK_PROFILES.map((r) => ({
                key: r.value,
                label: r.label,
                active: riskProfile === r.value,
              }))}
              onToggle={(k) => setRiskProfile(k as RiskProfile)}
            />
          </>
        ) : null}

        {step === 2 ? (
          <>
            <Field
              label="Duration"
              value={durationDays}
              onChangeText={setDurationDays}
              placeholder="90"
              keyboardType="number-pad"
              suffix="days"
              error={errors.durationDays}
              hint="How long the agreement runs before it settles."
            />
            <Field
              label="Max loss"
              value={maxLoss}
              onChangeText={setMaxLoss}
              placeholder="20"
              keyboardType="decimal-pad"
              suffix="%"
              error={errors.maxLoss}
              hint="The escrow rejects trades that would push the value below this."
            />
            {isTrader ? (
              <>
                <Field
                  label="Commission"
                  value={commission}
                  onChangeText={setCommission}
                  placeholder="20"
                  keyboardType="decimal-pad"
                  suffix="%"
                  error={errors.commission}
                  hint="Your share of the profit, written into the agreement."
                />
                <Field
                  label="Min. capital"
                  value={minCapital}
                  onChangeText={setMinCapital}
                  placeholder="1000"
                  keyboardType="decimal-pad"
                  suffix={assetCode}
                  error={errors.minCapital}
                />
                <View style={styles.row}>
                  <View style={styles.rowField}>
                    <Field
                      label="Expected return (min)"
                      value={returnMin}
                      onChangeText={setReturnMin}
                      placeholder="5"
                      keyboardType="decimal-pad"
                      suffix="%"
                    />
                  </View>
                  <View style={styles.rowField}>
                    <Field
                      label="(max)"
                      value={returnMax}
                      onChangeText={setReturnMax}
                      placeholder="15"
                      keyboardType="decimal-pad"
                      suffix="%"
                    />
                  </View>
                </View>
                {errors.returnRange ? (
                  <Text variant="caption" color="loss">
                    {errors.returnRange}
                  </Text>
                ) : null}
                <Text variant="caption" color="text3">
                  Expected return is an estimate, not a promise — returns depend on market
                  conditions and can be negative.
                </Text>
              </>
            ) : (
              <Field
                label="Capital"
                value={amount}
                onChangeText={setAmount}
                placeholder="1000"
                keyboardType="decimal-pad"
                suffix={assetCode}
                error={errors.amount}
                hint="Your capital stays in your wallet until you fund an agreement."
              />
            )}
          </>
        ) : null}

        {step === 3 ? (
          <Card style={styles.review}>
            <Text variant="h2">{payload.title}</Text>
            <Text variant="body" color="text2">
              {payload.description}
            </Text>
            <View style={styles.reviewGrid}>
              <ReviewItem label="Type" value={isTrader ? 'Service listing' : 'Capital listing'} />
              <ReviewItem label="Markets" value={markets.join(', ') || '—'} />
              <ReviewItem label="Risk" value={riskProfile ?? '—'} />
              <ReviewItem label="Duration" value={`${durationDays} days`} />
              <ReviewItem label="Max loss" value={`${maxLoss}%`} />
              {isTrader ? (
                <>
                  <ReviewItem label="Commission" value={`${commission}%`} />
                  <ReviewItem
                    label="Min. capital"
                    value={formatAmount(payload.min_capital as string, assetCode)}
                  />
                </>
              ) : (
                <ReviewItem
                  label="Capital"
                  value={formatAmount(payload.amount as string, assetCode)}
                />
              )}
            </View>
            {create.isError ? (
              <ErrorNotice title="Could not publish" error={create.error} />
            ) : null}
          </Card>
        ) : null}

        <View style={styles.footer}>
          {step > 0 ? (
            <Button title="Back" variant="secondary" onPress={() => setStep((s) => s - 1)} />
          ) : null}
          <View style={{ flex: 1 }} />
          {step < steps.length - 1 ? (
            <Button title="Continue" onPress={goNext} />
          ) : (
            <Button
              title="Publish listing"
              loading={create.isPending}
              onPress={() => create.mutate(payload)}
            />
          )}
        </View>
      </View>
    </Screen>
  );
}

function ChipGroup({
  label,
  options,
  onToggle,
  error,
  hint,
}: {
  label: string;
  options: { key: string; label: string; active: boolean }[];
  onToggle: (key: string) => void;
  error?: string;
  hint?: string;
}) {
  return (
    <View style={styles.group}>
      <Text variant="captionStrong" color="text2">
        {label}
      </Text>
      <View style={styles.chips}>
        {options.map((o) => (
          <Chip key={o.key} label={o.label} active={o.active} onPress={() => onToggle(o.key)} />
        ))}
      </View>
      {error ? (
        <Text variant="caption" color="loss">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" color="text3">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.reviewItem}>
      <Text variant="caption" color="text3">
        {label}
      </Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.lg },
  group: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  rowField: { flex: 1 },
  review: { gap: spacing.sm },
  reviewGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  reviewItem: { gap: 2, flexBasis: '45%', flexGrow: 1 },
  errorBox: { gap: 2, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.redBg },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
