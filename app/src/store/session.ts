import { create } from 'zustand';

import { profileApi } from '@/lib/api';
import { loginWithSep10 } from '@/lib/auth';
import { STORAGE_KEYS, plainStorage, secureStorage } from '@/lib/storage';
import { wallet } from '@/lib/wallet';
import type { Role, UserProfile } from '@/types';

/**
 * Oturum durumu — cüzdan adresi, rol, JWT.
 * Rol yönlendirmesi app/index.tsx'te bu store'a göre yapılır.
 */
export type SessionStatus = 'booting' | 'signed_out' | 'wallet_connected' | 'signed_in';

interface SessionState {
  status: SessionStatus;
  address: string | null;
  role: Role | null;
  profile: UserProfile | null;
  onboardingSeen: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  markOnboardingSeen: () => Promise<void>;
  connectWallet: () => Promise<string>;
  signIn: () => Promise<void>;
  /** Kayıt: rol + form → backend; başarılıysa profile/rol set edilir. */
  register: (payload: { role: Role } & Record<string, unknown>) => Promise<void>;
  signOut: () => Promise<void>;
}

interface PersistedSession {
  address: string;
  role: Role | null;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'booting',
  address: null,
  role: null,
  profile: null,
  onboardingSeen: false,
  error: null,

  async hydrate() {
    const [seen, jwt, raw] = await Promise.all([
      plainStorage.get(STORAGE_KEYS.onboardingSeen),
      secureStorage.get(STORAGE_KEYS.jwt),
      secureStorage.get(STORAGE_KEYS.session),
    ]);
    const persisted = raw ? (JSON.parse(raw) as PersistedSession) : null;

    if (jwt && persisted) {
      set({
        status: 'signed_in',
        address: persisted.address,
        role: persisted.role,
        onboardingSeen: !!seen,
      });
      // Profil taze mi? Sessizce yenile; 401 gelirse oturumu kapat.
      profileApi
        .me()
        .then((profile) => set({ profile, role: profile.role }))
        .catch(() => get().signOut());
      return;
    }
    set({ status: 'signed_out', onboardingSeen: !!seen });
  },

  async markOnboardingSeen() {
    await plainStorage.set(STORAGE_KEYS.onboardingSeen, '1');
    set({ onboardingSeen: true });
  },

  async connectWallet() {
    set({ error: null });
    const { address } = await wallet.connect();
    set({ address, status: 'wallet_connected' });
    return address;
  },

  async signIn() {
    const address = get().address ?? (await get().connectWallet());
    set({ error: null });
    try {
      const { token } = await loginWithSep10(address);
      await secureStorage.set(STORAGE_KEYS.jwt, token);
      const profile = await profileApi.me().catch(() => null); // kayıtsız cüzdan → null
      const role = profile?.role ?? null;
      await secureStorage.set(
        STORAGE_KEYS.session,
        JSON.stringify({ address, role } satisfies PersistedSession),
      );
      set({ status: 'signed_in', profile, role });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Giriş başarısız' });
      throw err;
    }
  },

  async register(payload) {
    const profile = await profileApi.register(payload);
    const address = get().address ?? profile.address;
    await secureStorage.set(
      STORAGE_KEYS.session,
      JSON.stringify({ address, role: profile.role } satisfies PersistedSession),
    );
    set({ profile, role: profile.role, status: 'signed_in' });
  },

  async signOut() {
    await Promise.all([
      secureStorage.remove(STORAGE_KEYS.jwt),
      secureStorage.remove(STORAGE_KEYS.session),
    ]);
    await wallet.disconnect().catch(() => undefined);
    set({ status: 'signed_out', address: null, role: null, profile: null, error: null });
  },
}));
