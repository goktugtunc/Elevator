import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AsyncBoundary, Screen, TopBar } from '@/components/layout';
import { Button, ErrorNotice, Field, Text } from '@/components/ui';
import { usersApi } from '@/lib/api';
import type { MeOut, UserUpdateIn } from '@/lib/api/types';
import { fieldErrors } from '@/lib/errors';
import { spacing } from '@/theme';

/**
 * Profil düzenleme — `PATCH /users/me`.
 *
 * Sunucu yalnızca gönderilen alanları uyguluyor ve rolüne ait olmayan alanı
 * reddediyor, bu yüzden gövde role göre kuruluyor. Metin alanları boş
 * bırakılırsa `null` gider (alanı temizler); değişmeyen alan hiç gönderilmez.
 */
export default function EditProfile() {
  const router = useRouter();
  const qc = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: usersApi.me });

  return (
    <Screen>
      <TopBar title="Edit profile" />
      <AsyncBoundary query={me}>
        {(user) => (
          <Form
            // Sunucudan taze veri gelirse form yeniden kurulur; alanları efektle
            // senkronlamak yerine bileşeni anahtarla tazelemek daha az sürprizli.
            key={user.updated_at ?? user.id}
            user={user}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ['me'] });
              void qc.invalidateQueries({ queryKey: ['user', user.id] });
              void qc.invalidateQueries({ queryKey: ['trader', user.id] });
              router.back();
            }}
          />
        )}
      </AsyncBoundary>
    </Screen>
  );
}

function Form({ user, onSaved }: { user: MeOut; onSaved: () => void }) {
  const isTrader = user.role === 'trader';

  const [displayName, setDisplayName] = useState(user.display_name);
  const [bio, setBio] = useState(user.bio ?? '');
  const [strategy, setStrategy] = useState(user.strategy_summary ?? '');
  const [portfolio, setPortfolio] = useState(user.portfolio ?? '');

  const save = useMutation({
    mutationFn: () => {
      const payload: UserUpdateIn = {};
      const trimmed = displayName.trim();
      if (trimmed && trimmed !== user.display_name) payload.display_name = trimmed;
      // Boş metin alanı = "temizle" (null); sunucu nullable alanlarda bunu kabul ediyor.
      if (bio.trim() !== (user.bio ?? '')) payload.bio = bio.trim() || null;
      if (isTrader) {
        if (strategy.trim() !== (user.strategy_summary ?? ''))
          payload.strategy_summary = strategy.trim() || null;
        if (portfolio.trim() !== (user.portfolio ?? ''))
          payload.portfolio = portfolio.trim() || null;
      }
      return usersApi.updateMe(payload);
    },
    onSuccess: onSaved,
  });

  const errors = fieldErrors(save.error);
  const dirty =
    displayName.trim() !== user.display_name ||
    bio.trim() !== (user.bio ?? '') ||
    (isTrader &&
      (strategy.trim() !== (user.strategy_summary ?? '') ||
        portfolio.trim() !== (user.portfolio ?? '')));

  return (
    <View style={styles.body}>
      <Field
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={80}
        error={errors.display_name}
      />
      <Field
        label="Bio"
        value={bio}
        onChangeText={setBio}
        placeholder="A line or two about you"
        multiline
        maxLength={2000}
        error={errors.bio}
      />

      {isTrader ? (
        <>
          <Field
            label="Strategy"
            value={strategy}
            onChangeText={setStrategy}
            placeholder="How you trade: markets, holding period, how you size positions"
            multiline
            maxLength={2000}
            error={errors.strategy_summary}
          />
          <Field
            label="Portfolio"
            value={portfolio}
            onChangeText={setPortfolio}
            placeholder="Your track record in your own words: which trades you made, what worked, what did not"
            multiline
            maxLength={4000}
            hint="Investors see your on-chain numbers anyway; this is the story behind them."
            error={errors.portfolio}
          />
        </>
      ) : null}

      {save.isError ? <ErrorNotice title="Could not save" error={save.error} /> : null}

      <Button title="Save" loading={save.isPending} disabled={!dirty} onPress={() => save.mutate()} />
      <Text variant="caption" color="text3">
        Your username and wallet address cannot be changed.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
});
