import { create } from 'zustand';

import { profileApi, registerAuthBridge, type RegisterPayload } from '@/lib/api';
import { isExpired, loginWithSep10, startSep7SignIn, waitForSep7 } from '@/lib/auth';
import { userMessage } from '@/lib/errors';
import { STORAGE_KEYS, plainStorage, secureStorage } from '@/lib/storage';
import { localWallet, restoreWalletMode, wallet } from '@/lib/wallet';
import type { NativeWalletMode } from '@/lib/wallet';
import type { Role, UserProfile } from '@/types';

/**
 * Oturum durumu — cüzdan adresi, rol, JWT.
 * Rol yönlendirmesi app/index.tsx'te bu store'a göre yapılır.
 *
 * JWT yenileme (FE-04): SEP-10'da yenileme token'ı yoktur; süre dolduğunda ya da
 * 401 geldiğinde challenge yeniden imzalatılır. Bu yüzden yenileme "sessiz" değil,
 * cüzdanda bir imza isteği açar. Başarısız olursa oturum kapatılır.
 */
export type SessionStatus = 'booting' | 'signed_out' | 'wallet_connected' | 'signed_in';

/** İmza yolu. `sep7` imzayı cihazda üretmez; cüzdan imzalı XDR'ı backend'e gönderir. */
export type WalletMode = NativeWalletMode | 'sep7';

interface SessionState {
  status: SessionStatus;
  address: string | null;
  role: Role | null;
  profile: UserProfile | null;
  /** JWT'nin bitiş anı (ms epoch); sunucu bildirmediyse null. */
  expiresAt: number | null;
  /** Mobilde WalletConnect eşleşme URI'si — UI QR/deep link gösterir. */
  pairingUri: string | null;
  /** Hangi imza yolu kullanılıyor: uygulama içi cüzdan, WalletConnect ya da SEP-7. */
  walletMode: WalletMode | null;
  onboardingSeen: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  markOnboardingSeen: () => Promise<void>;
  connectWallet: (options?: { mode?: NativeWalletMode; walletId?: string }) => Promise<string>;
  cancelPairing: () => void;
  /** Uygulama içi cüzdan: var olanı yükler, yoksa üretir. */
  useLocalWallet: () => Promise<string>;
  /** Var olan gizli anahtarı içe aktarır (S…). */
  importLocalWallet: (secret: string) => Promise<string>;
  /** SEP-7: challenge'ı harici cüzdanda imzalatır, sonucu bekler. */
  signInWithSep7: (address: string, isCancelled?: () => boolean) => Promise<void>;
  signIn: () => Promise<void>;
  /** Kayıt: rol + form → backend; başarılıysa profile/rol set edilir. */
  register: (payload: RegisterPayload) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

interface PersistedSession {
  address: string;
  role: Role | null;
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

    // Token'ın süresi dolmuşsa hiç denemeden girişe düş (401 turu atmadan).
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

    // Profil taze mi? Sessizce yenile; 401 gelirse api istemcisi köprüyü tetikler.
    profileApi
      .me()
      .then((profile) => set({ profile, role: profile.role }))
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

  async useLocalWallet() {
    const address = (await localWallet.address()) ?? (await localWallet.create());
    set({ address, status: 'wallet_connected', walletMode: 'local', error: null });
    return address;
  },

  async importLocalWallet(secret) {
    const address = await localWallet.importSecret(secret);
    set({ address, status: 'wallet_connected', walletMode: 'local', error: null });
    return address;
  },

  async signInWithSep7(address, isCancelled) {
    set({ error: null, address, walletMode: 'sep7' });
    try {
      const { requestId } = await startSep7SignIn(address);
      const { token, expiresAt } = await waitForSep7(requestId, { isCancelled });
      await secureStorage.set(STORAGE_KEYS.jwt, token);
      const profile = await profileApi.me().catch(() => null);
      const role = profile?.role ?? null;
      await persist({ address, role, expiresAt });
      set({ status: 'signed_in', profile, role, expiresAt });
    } catch (err) {
      set({ error: userMessage(err) });
      throw err;
    }
  },

  cancelPairing() {
    set({ pairingUri: null });
  },

  async signIn() {
    const address = get().address ?? (await get().connectWallet());
    set({ error: null });
    try {
      const { token, expiresAt } = await loginWithSep10(address);
      await secureStorage.set(STORAGE_KEYS.jwt, token);
      const profile = await profileApi.me().catch(() => null); // kayıtsız cüzdan → null
      const role = profile?.role ?? null;
      await persist({ address, role, expiresAt });
      set({ status: 'signed_in', profile, role, address, expiresAt });
    } catch (err) {
      set({ error: userMessage(err) });
      throw err;
    }
  },

  async register(payload) {
    const profile = await profileApi.register(payload);
    const address = get().address ?? profile.address;
    await persist({ address, role: profile.role, expiresAt: get().expiresAt });
    set({ profile, role: profile.role, address, status: 'signed_in' });
  },

  async signOut() {
    await clearStoredSession();
    await wallet.disconnect().catch(() => undefined);
    set({
      status: 'signed_out',
      address: null,
      role: null,
      profile: null,
      expiresAt: null,
      pairingUri: null,
      error: null,
    });
  },

  clearError() {
    set({ error: null });
  },
}));

/**
 * 401 köprüsü: api istemcisi yetkisiz yanıt aldığında bir kez SEP-10 yenilemesi
 * dener (cüzdanda imza isteği açılır), başarısızsa oturumu kapatır.
 * Eşzamanlı 401'ler tek yenileme isteğinde birleşir.
 */
let refreshInFlight: Promise<string | null> | null = null;

registerAuthBridge({
  async refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const state = useSession.getState();
      const address = state.address ?? (await wallet.getAddress().catch(() => null));
      if (!address) return null;
      try {
        const { token, expiresAt } = await loginWithSep10(address);
        await secureStorage.set(STORAGE_KEYS.jwt, token);
        await persist({ address, role: state.role, expiresAt });
        useSession.setState({ address, expiresAt, status: 'signed_in', error: null });
        return token;
      } catch {
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
      expiresAt: null,
      error: 'Your session expired. Sign in again with your wallet.',
    });
  },
});
