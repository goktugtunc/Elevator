import { create } from 'zustand';

import { authApi, registerAuthBridge, usersApi } from '@/lib/api';
import { ApiError } from '@/lib/api/client';
import type { MeOut, RegisterIn, RegisterOut, UserRole } from '@/lib/api/types';
import { isExpired, loginWithSep10 } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { debugError, debugLog } from '@/lib/log';
import { STORAGE_KEYS, plainStorage, secureStorage } from '@/lib/storage';
import { localWallet, restoreWalletMode, wallet } from '@/lib/wallet';
import type { NativeWalletMode } from '@/lib/wallet';

/**
 * Oturum durumu — cüzdan adresi, rol, JWT.
 * Rol yönlendirmesi app/index.tsx'te bu store'a göre yapılır.
 *
 * Sunucu `LoginOut` ile token'ın yanında `registered` ve `user` döndürüyor;
 * kayıtsız cüzdanda `role` null kalır ve kullanıcı kayıt akışına düşer.
 * JWT süresi dolmadan `POST /auth/refresh` ile yenilenir — bu, cüzdanda
 * yeni bir imza istemez (SEP-10 challenge'ı tekrar imzalamaya gerek yok).
 */
export type SessionStatus = 'booting' | 'signed_out' | 'wallet_connected' | 'signed_in';

interface SessionState {
  status: SessionStatus;
  address: string | null;
  role: UserRole | null;
  profile: MeOut | null;
  /** Cüzdan sunucuda kayıtlı mı (rol + kullanıcı adı verilmiş mi). */
  registered: boolean;
  /** JWT'nin bitiş anı (ms epoch). */
  expiresAt: number | null;
  /** WalletConnect eşleşme URI'si — UI QR/deep link gösterir. */
  pairingUri: string | null;
  walletMode: NativeWalletMode | null;
  onboardingSeen: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  markOnboardingSeen: () => Promise<void>;
  connectWallet: (options?: { mode?: NativeWalletMode; walletId?: string }) => Promise<string>;
  cancelPairing: () => void;
  signIn: () => Promise<void>;
  register: (payload: RegisterIn) => Promise<void>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Cihazdaki her izi siler — cüzdan anahtarı ve onboarding dâhil (test için). */
  resetAll: () => Promise<void>;
  clearError: () => void;
}

interface PersistedSession {
  address: string;
  role: UserRole | null;
  expiresAt: number | null;
}

async function persist(session: PersistedSession): Promise<void> {
  await secureStorage.set(STORAGE_KEYS.session, JSON.stringify(session));
}

async function clearStoredSession(): Promise<void> {
  await Promise.all([
    secureStorage.remove(STORAGE_KEYS.jwt),
    secureStorage.remove(STORAGE_KEYS.session),
  ]);
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'booting',
  address: null,
  role: null,
  profile: null,
  registered: false,
  expiresAt: null,
  pairingUri: null,
  walletMode: null,
  onboardingSeen: false,
  error: null,

  async hydrate() {
    const [seen, jwt, raw] = await Promise.all([
      plainStorage.get(STORAGE_KEYS.onboardingSeen),
      secureStorage.get(STORAGE_KEYS.jwt),
      secureStorage.get(STORAGE_KEYS.session),
    ]);
    const persisted = raw ? (JSON.parse(raw) as PersistedSession) : null;
    const onboardingSeen = !!seen;
    set({ walletMode: await restoreWalletMode() });

    if (!jwt || !persisted) {
      set({ status: 'signed_out', onboardingSeen });
      return;
    }

    if (isExpired(persisted.expiresAt)) {
      await clearStoredSession();
      set({
        status: 'signed_out',
        onboardingSeen,
        address: persisted.address,
        error: 'Your session expired. Sign in again with your wallet.',
      });
      return;
    }

    set({
      status: 'signed_in',
      address: persisted.address,
      role: persisted.role,
      expiresAt: persisted.expiresAt,
      onboardingSeen,
    });

    // Profil ve kayıt durumu tazelensin; 401 gelirse köprü devreye girer.
    get()
      .refreshProfile()
      .catch(() => undefined);
  },

  async markOnboardingSeen() {
    await plainStorage.set(STORAGE_KEYS.onboardingSeen, '1');
    set({ onboardingSeen: true });
  },

  async connectWallet(options) {
    set({ error: null, pairingUri: null });
    try {
      const { address } = await wallet.connect({
        mode: options?.mode,
        walletId: options?.walletId,
        onUri: (uri) => set({ pairingUri: uri }),
      });
      set({
        address,
        status: 'wallet_connected',
        pairingUri: null,
        walletMode: options?.mode ?? get().walletMode ?? 'local',
      });
      return address;
    } catch (err) {
      set({ pairingUri: null });
      throw err;
    }
  },

  cancelPairing() {
    set({ pairingUri: null });
    void wallet.abortPairing?.();
  },

  async signIn() {
    const address = get().address ?? (await get().connectWallet());
    set({ error: null });
    try {
      const session = await loginWithSep10(address);
      await secureStorage.set(STORAGE_KEYS.jwt, session.token);
      const role = session.user?.role ?? null;
      await persist({ address, role, expiresAt: session.expiresAt });
      set({
        status: 'signed_in',
        address,
        role,
        profile: session.user,
        registered: session.registered,
        expiresAt: session.expiresAt,
      });
    } catch (err) {
      set({ error: userMessage(err) });
      throw err;
    }
  },

  async register(payload) {
    // Sunucu profili **ve rolü taşıyan yeni bir token** döndürür (RegisterOut);
    // eski token rolsüzdür, bu yüzden yenisi saklanır.
    let out: RegisterOut;
    try {
      out = await usersApi.register(payload);
    } catch (err) {
      // 409 iki anlama gelir: cüzdan zaten kayıtlı ya da kullanıcı adı alınmış.
      // Cüzdan çakışmasında yeni bir SEP-10 girişi rolü taşıyan token'ı getirir ve
      // akış açılır. Kullanıcı adı çakışmasında ise girişi tekrarlamak anlamsız —
      // üstelik WalletConnect'te cüzdana gereksiz bir imza isteği düşürüyordu.
      if (err instanceof ApiError && err.status === 409 && err.code !== 'username_taken') {
        await get().signIn();
        if (get().role) return;
      }
      throw err;
    }
    const { user, token, expires_at } = out;
    const address = get().address ?? user.stellar_address;
    const expiresAtMs = expires_at ? Date.parse(expires_at) : NaN;
    const expiresAt = Number.isFinite(expiresAtMs) ? expiresAtMs : get().expiresAt;
    await secureStorage.set(STORAGE_KEYS.jwt, token);
    await persist({ address, role: user.role, expiresAt });
    set({
      profile: user,
      role: user.role,
      registered: true,
      address,
      expiresAt,
      status: 'signed_in',
    });
    debugLog('auth', 'kayıt tamam', { role: user.role, username: user.username });
  },

  async refreshProfile() {
    const me = await authApi.me();
    set({
      profile: me.user,
      role: me.user?.role ?? null,
      registered: me.registered,
      address: me.public_key,
    });
  },

  async signOut() {
    await clearStoredSession();
    await wallet.disconnect().catch(() => undefined);
    set({
      status: 'signed_out',
      address: null,
      role: null,
      profile: null,
      registered: false,
      expiresAt: null,
      pairingUri: null,
      error: null,
    });
  },

  async resetAll() {
    await clearStoredSession();
    await wallet.disconnect().catch(() => undefined);
    // signOut'tan farkı: uygulama içi cüzdanın gizli anahtarı ve tercihler de gider,
    // böylece bir sonraki bağlanışta yeni bir adres üretilir — sıfırdan test.
    await localWallet.forget().catch(() => undefined);
    await Promise.all([
      plainStorage.remove(STORAGE_KEYS.walletMode),
      plainStorage.remove(STORAGE_KEYS.onboardingSeen),
    ]);
    debugLog('session', 'cihazdaki oturum ve cüzdan verisi silindi');
    set({
      status: 'signed_out',
      address: null,
      role: null,
      profile: null,
      registered: false,
      expiresAt: null,
      pairingUri: null,
      walletMode: null,
      onboardingSeen: false,
      error: null,
    });
  },

  clearError() {
    set({ error: null });
  },
}));

/**
 * 401 köprüsü: önce `POST /auth/refresh` denenir (cüzdan imzası gerekmez).
 * O da başarısızsa oturum kapatılır ve kullanıcı girişe yönlendirilir.
 * Eşzamanlı 401'ler tek yenileme isteğinde birleşir.
 */
let refreshInFlight: Promise<string | null> | null = null;

registerAuthBridge({
  async refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const login = await authApi.refresh();
        const expiresAtMs = login.expires_at ? Date.parse(login.expires_at) : NaN;
        const expiresAt = Number.isFinite(expiresAtMs) ? expiresAtMs : null;
        await secureStorage.set(STORAGE_KEYS.jwt, login.token);
        await persist({
          address: login.public_key,
          role: login.user?.role ?? null,
          expiresAt,
        });
        useSession.setState({
          address: login.public_key,
          role: login.user?.role ?? null,
          profile: login.user,
          registered: login.registered,
          expiresAt,
          status: 'signed_in',
          error: null,
        });
        debugLog('auth', 'JWT yenilendi');
        return login.token;
      } catch (err) {
        debugError('auth', 'JWT yenilenemedi', err);
        return null;
      }
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  },

  onSessionExpired() {
    void clearStoredSession();
    useSession.setState({
      status: 'signed_out',
      role: null,
      profile: null,
      registered: false,
      expiresAt: null,
      error: 'Your session expired. Sign in again with your wallet.',
    });
  },
});
