import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Screen, TopBar } from '@/components/layout';
import { Button, Card, Chip, Field, Pill, Progress, Text } from '@/components/ui';
import { type RegisterPayload } from '@/lib/api';
import { userMessage } from '@/lib/errors';
import { parseTRNumber } from '@/lib/format';
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
    if (name.length < 3) next.username = 'En az 3 karakter olmalı.';
    else if (name.length > 24) next.username = 'En fazla 24 karakter olabilir.';
    else if (!/^[a-zA-Z0-9._]+$/.test(name))
      next.username = 'Yalnızca harf, rakam, nokta ve alt çizgi kullanılabilir.';
    if (markets.length === 0) next.markets = 'En az bir piyasa seç.';

    if (!isTrader) {
      const budgetTRY = parseTRNumber(budget);
      if (budgetTRY === null || budgetTRY <= 0) next.budget = 'Geçerli bir tutar gir.';
      if (!risk) next.risk = 'Risk tercihini seç.';
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
    if (summary.length < 20) next.strategy = 'Stratejini en az 20 karakterle anlat.';
    else if (summary.length > 280) next.strategy = 'En fazla 280 karakter olabilir.';
    const commissionPct = parseTRNumber(commission);
    if (commissionPct === null || commissionPct <= 0 || commissionPct > 50)
      next.commission = '%0 ile %50 arasında bir oran gir.';
    const minCapitalTRY = parseTRNumber(minCapital);
    if (minCapitalTRY === null || minCapitalTRY <= 0) next.minCapital = 'Geçerli bir tutar gir.';
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
      <TopBar title="Kayıt Ol" />
      <View style={styles.body}>
        <Progress
          value={1}
          label={`Adım 2/2 · ${isTrader ? 'Trader Bilgileri' : 'Müşteri Bilgileri'}`}
        />

        <View style={{ gap: spacing.xs }}>
          <Text variant="h1">Seni tanıyalım</Text>
          <Text variant="body" color="text2">
            {isTrader
              ? 'Bu bilgiler hizmet ilanında ve trader profilinde yatırımcılara gösterilir.'
              : 'Bu bilgiler sana uygun trader’ları önermek ve sermaye ilanını hazırlamak için kullanılır.'}
          </Text>
        </View>

        <Card style={styles.walletCard}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="captionStrong" color="text2">
              Cüzdan Adresi
            </Text>
            <Text variant="numericSm">{address ? shortAddress(address, 6, 6) : 'Bağlı değil'}</Text>
          </View>
          {address ? (
            <Pill label="Bağlı" tone="navy" />
          ) : (
            <Button
              title="Cüzdan Bağla"
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
          label="Kullanıcı Adı"
          value={username}
          onChangeText={setUsername}
          placeholder={isTrader ? 'ör. kaandemir' : 'ör. elifyilmaz'}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={24}
          error={errors.username}
          hint="Profilinde @kullaniciadi olarak görünür."
        />

        {isTrader ? (
          <>
            <ChipGroup
              label="Uzman Olduğun Piyasalar"
              error={errors.markets}
              hint="Birden fazla seçebilirsin."
              options={MARKETS.map((m) => ({ key: m, label: m, active: markets.includes(m) }))}
              onToggle={(key) => toggleMarket(key as Market)}
            />
            <Field
              label="Strateji Özeti"
              value={strategy}
              onChangeText={setStrategy}
              placeholder="Hangi piyasada, hangi vadede, nasıl bir risk yönetimiyle işlem yapıyorsun?"
              multiline
              maxLength={280}
              error={errors.strategy}
              hint={`${strategy.trim().length}/280 · Yatırımcılar bu metni profilinde görür.`}
            />
            <Field
              label="Komisyon Oranı"
              value={commission}
              onChangeText={setCommission}
              placeholder="20"
              keyboardType="decimal-pad"
              suffix="%"
              error={errors.commission}
              hint="Kârdan alacağın pay. Sözleşmede bu oran yazılır."
            />
            <Field
              label="Min. Sermaye"
              value={minCapital}
              onChangeText={setMinCapital}
              placeholder="50.000"
              keyboardType="decimal-pad"
              suffix="TL"
              error={errors.minCapital}
              hint="Bu tutarın altındaki teklifler sana gösterilmez."
            />
          </>
        ) : (
          <>
            <Field
              label="Yatırım Bütçesi"
              value={budget}
              onChangeText={setBudget}
              placeholder="250.000"
              keyboardType="decimal-pad"
              suffix="TL"
              error={errors.budget}
              hint="Sermayen cüzdanında kalır; bu tutar yalnızca eşleştirme için kullanılır."
            />
            <ChipGroup
              label="Risk Tercihi"
              error={errors.risk}
              options={RISK_LEVELS.map((level) => ({
                key: level,
                label: RISK_LABEL[level],
                active: risk === level,
              }))}
              onToggle={(key) => setRisk(key as RiskLevel)}
            />
            <ChipGroup
              label="İlgilendiğin Piyasalar"
              error={errors.markets}
              hint="Birden fazla seçebilirsin."
              options={MARKETS.map((m) => ({ key: m, label: m, active: markets.includes(m) }))}
              onToggle={(key) => toggleMarket(key as Market)}
            />
          </>
        )}

        {formError ? (
          <View style={styles.errorBox}>
            <Text variant="captionStrong" color="loss">
              Kayıt tamamlanamadı
            </Text>
            <Text variant="caption" color="text2">
              {formError}
            </Text>
          </View>
        ) : null}

        <Button title="Kaydı Tamamla" fullWidth loading={busy} onPress={onSubmit} />
        <Text variant="caption" color="text3" align="center">
          Kaydı tamamladığında rolün cüzdan adresine bağlanır ve giriş için SEP-10 imzası istenir.
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
