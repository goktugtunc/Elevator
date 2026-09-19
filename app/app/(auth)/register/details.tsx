import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen, TopBar } from '@/components/layout';
import { Button, Card, Chip, Field, Pill, Progress, Text } from '@/components/ui';
import { type RegisterPayload } from '@/lib/api';
import { userMessage } from '@/lib/errors';
import { parseNumberInput } from '@/lib/format';
import { shortAddress } from '@/lib/stellar';
import { useSession } from '@/store/session';
import { MARKETS, RISK_LABEL, RISK_LEVELS, type Market, type RiskLevel } from '@/types';
import { colors, radius, spacing } from '@/theme';

/**
 * Figma 1f · Kayıt · Bilgiler (Müşteri) — node 19:269
 * Figma 1g · Kayıt · Bilgiler (Trader)  — node 19:353
 * Adım 2/2 (FE-03). Gönderim: `session.register()` → `POST /register` (BE-01).
 */
type Errors = Partial<Record<string, string>>;

export default function RegisterDetails() {
  const router = useRouter();
  const { role } = useLocalSearchParams<{ role?: string }>();
  const isTrader = role === 'trader';

  const address = useSession((s) => s.address);
  const status = useSession((s) => s.status);
  const signIn = useSession((s) => s.signIn);
  const register = useSession((s) => s.register);

  const [username, setUsername] = useState('');
  const [budget, setBudget] = useState('');
  const [risk, setRisk] = useState<RiskLevel | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [strategy, setStrategy] = useState('');
  const [commission, setCommission] = useState('');
  const [minCapital, setMinCapital] = useState('');

  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Rol parametresi yoksa (derin link, yenileme) 1. adıma dön.
  if (role !== 'customer' && role !== 'trader') {
    return <Redirect href="/(auth)/register/role" />;
  }

  const toggleMarket = (m: Market) =>
    setMarkets((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const buildPayload = (): { payload?: RegisterPayload; errors: Errors } => {
    const next: Errors = {};
    const name = username.trim();
    if (name.length < 3) next.username = 'Use at least 3 characters.';
    else if (name.length > 24) next.username = 'Use at most 24 characters.';
    else if (!/^[a-zA-Z0-9._]+$/.test(name))
      next.username = 'Letters, numbers, dots and underscores only.';
    if (markets.length === 0) next.markets = 'Pick at least one market.';

    if (!isTrader) {
      const budgetTRY = parseNumberInput(budget);
      if (budgetTRY === null || budgetTRY <= 0) next.budget = 'Enter a valid amount.';
      if (!risk) next.risk = 'Choose your risk preference.';
      if (Object.keys(next).length > 0) return { errors: next };
      return {
        errors: next,
        payload: {
          role: 'customer',
          username: name,
          budgetTRY: budgetTRY as number,
          riskPreference: risk as RiskLevel,
          markets,
        },
      };
    }

    const summary = strategy.trim();
    if (summary.length < 20) next.strategy = 'Describe your strategy in at least 20 characters.';
    else if (summary.length > 280) next.strategy = 'Use at most 280 characters.';
    const commissionPct = parseNumberInput(commission);
    if (commissionPct === null || commissionPct <= 0 || commissionPct > 50)
      next.commission = 'Enter a rate between 0% and 50%.';
    const minCapitalTRY = parseNumberInput(minCapital);
    if (minCapitalTRY === null || minCapitalTRY <= 0) next.minCapital = 'Enter a valid amount.';
    if (Object.keys(next).length > 0) return { errors: next };
    return {
      errors: next,
      payload: {
        role: 'trader',
        username: name,
        markets,
        strategySummary: summary,
        commissionPct: commissionPct as number,
        minCapitalTRY: minCapitalTRY as number,
      },
    };
  };

  const onSubmit = async () => {
    const { payload, errors: found } = buildPayload();
    setErrors(found);
    if (!payload) return;

    setBusy(true);
    setFormError(null);
    try {
      // Kayıt korumalı uç nokta: JWT yoksa önce cüzdan + SEP-10 girişi yapılır.
      if (status !== 'signed_in') await signIn();
      await register(payload);
      router.replace('/');
    } catch (err) {
      setFormError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen padded={false}>
      <TopBar title="Sign up" />
      <View style={styles.body}>
        <Progress
          value={1}
          label={`Step 2 of 2 · ${isTrader ? 'Trader details' : 'Customer details'}`}
        />

        <View style={{ gap: spacing.xs }}>
          <Text variant="h1">Tell us about you</Text>
          <Text variant="body" color="text2">
            {isTrader
              ? 'Investors see this on your service listing and trader profile.'
              : 'We use this to suggest traders that fit you and to prefill your capital listing.'}
          </Text>
        </View>

        <Card style={styles.walletCard}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="captionStrong" color="text2">
              Wallet address
            </Text>
            <Text variant="numericSm">
              {address ? shortAddress(address, 6, 6) : 'Not connected'}
            </Text>
          </View>
          {address ? (
            <Pill label="Connected" tone="navy" />
          ) : (
            <Button
              title="Connect wallet"
              variant="secondary"
              size="sm"
              loading={busy}
              onPress={() => {
                setFormError(null);
                signIn().catch((err) => setFormError(userMessage(err)));
              }}
            />
          )}
        </Card>

        <Field
          label="Username"
          value={username}
          onChangeText={setUsername}
          placeholder={isTrader ? 'e.g. kaandemir' : 'e.g. elifyilmaz'}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={24}
          error={errors.username}
          hint="Shown as @username on your profile."
        />

        {isTrader ? (
          <>
            <ChipGroup
              label="Markets you specialise in"
              error={errors.markets}
              hint="Pick as many as you like."
              options={MARKETS.map((m) => ({ key: m, label: m, active: markets.includes(m) }))}
              onToggle={(key) => toggleMarket(key as Market)}
            />
            <Field
              label="Strategy summary"
              value={strategy}
              onChangeText={setStrategy}
              placeholder="Which markets, what time horizon, how do you manage risk?"
              multiline
              maxLength={280}
              error={errors.strategy}
              hint={`${strategy.trim().length}/280 · Investors read this on your profile.`}
            />
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
            <Field
              label="Min. capital"
              value={minCapital}
              onChangeText={setMinCapital}
              placeholder="50,000"
              keyboardType="decimal-pad"
              suffix="TRY"
              error={errors.minCapital}
              hint="Offers below this amount are hidden from you."
            />
          </>
        ) : (
          <>
            <Field
              label="Investment budget"
              value={budget}
              onChangeText={setBudget}
              placeholder="250,000"
              keyboardType="decimal-pad"
              suffix="TRY"
              error={errors.budget}
              hint="Your capital stays in your wallet; this is only used for matching."
            />
            <ChipGroup
              label="Risk preference"
              error={errors.risk}
              options={RISK_LEVELS.map((level) => ({
                key: level,
                label: RISK_LABEL[level],
                active: risk === level,
              }))}
              onToggle={(key) => setRisk(key as RiskLevel)}
            />
            <ChipGroup
              label="Markets you care about"
              error={errors.markets}
              hint="Pick as many as you like."
              options={MARKETS.map((m) => ({ key: m, label: m, active: markets.includes(m) }))}
              onToggle={(key) => toggleMarket(key as Market)}
            />
          </>
        )}

        {formError ? (
          <View style={styles.errorBox}>
            <Text variant="captionStrong" color="loss">
              Sign-up failed
            </Text>
            <Text variant="caption" color="text2">
              {formError}
            </Text>
          </View>
        ) : null}

        <Button title="Create account" fullWidth loading={busy} onPress={onSubmit} />
        <Text variant="caption" color="text3" align="center">
          Finishing sign-up links your role to this wallet address and asks for a SEP-10 signature.
        </Text>
      </View>
    </Screen>
  );
}

/** Etiketli chip grubu — tek seçim (Risk Tercihi) ve çok seçim (Piyasalar) için. */
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

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.lg },
  walletCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
  },
  group: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  errorBox: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.redBg,
  },
});
