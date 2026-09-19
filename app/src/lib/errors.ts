import { ApiError } from '@/lib/api/client';
import { Sep10Error } from '@/lib/auth/sep10';
import { stellarConfig } from '@/lib/stellar/config';
import { WalletError } from '@/lib/wallet/types';

/**
 * Hata → kullanıcıya gösterilecek metin (tek kaynak).
 *
 * Kural: **sunucunun kendi mesajı esastır.** API tutarlı bir zarf döndürüyor —
 * `{ code, message, details }` — ve mesajları zaten insan okuyacak şekilde
 * yazılmış ("Username is already taken", "Missing bearer token"). Bunları sabit
 * cümlelerle değiştirmek kullanıcıyı körleştiriyordu; artık yalnızca sunucu bir
 * şey söylemediğinde ya da teknik metin kullanıcıya bir şey ifade etmediğinde
 * (ağ hatası, oturum süresi) kendi metnimizi koyuyoruz.
 */
export function userMessage(err: unknown): string {
  if (err instanceof WalletError) {
    switch (err.code) {
      case 'USER_REJECTED':
        return 'The request was rejected in your wallet. Approve it to finish signing in.';
      case 'WRONG_NETWORK':
        return `Your wallet is on a different network. Switch it to ${networkLabel()} and try again.`;
      case 'NOT_AVAILABLE':
      case 'MISSING_CONFIG':
      case 'NOT_CONNECTED':
        return err.message;
      default:
        return err.message || 'Wallet error.';
    }
  }

  if (err instanceof Sep10Error) {
    switch (err.code) {
      case 'WRONG_NETWORK':
        return `The server and your wallet are on different networks. This app runs on ${networkLabel()}.`;
      case 'EXPIRED_CHALLENGE':
        return 'The sign-in request expired. Please try again.';
      case 'ADDRESS_MISMATCH':
        return 'The sign-in request was issued for a different wallet address. Check your wallet.';
      default:
        return err.message;
    }
  }

  if (err instanceof ApiError) {
    // Ağa hiç çıkamadık: sunucunun söyleyecek bir şeyi yok.
    if (err.status === 0) {
      return 'Could not reach the server. Check your connection and try again.';
    }
    // Oturum bitti: sunucu "Missing bearer token" diyor, kullanıcı için anlamsız.
    if (err.status === 401) {
      return 'Your session has expired. Sign in again with your wallet.';
    }
    // Doğrulama hatasında zarfın üst mesajı genel ("Invalid request");
    // asıl bilgi alan listesinde.
    if (err.status === 422) {
      const fields = fieldErrors(err);
      const first = Object.values(fields)[0];
      if (first) return first;
    }
    const server = serverMessage(err);
    if (server) return server;
    return err.status >= 500
      ? `Server error (${err.status}). Please try again in a moment.`
      : 'Something went wrong. Please try again.';
  }

  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

/**
 * Sunucunun mesajı — yalnızca gerçekten insan için yazılmışsa.
 * İstemcinin ürettiği yedek metin ("POST /x → 500") kullanıcıya gösterilmez.
 */
function serverMessage(err: ApiError): string | null {
  const msg = err.message?.trim();
  if (!msg) return null;
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/.test(msg)) return null;
  return msg;
}

/** Makine okunur hata kodu (`username_taken`, `validation_error`…). */
export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? (err.code ?? null) : null;
}

/**
 * Sunucunun alan bazlı doğrulama hataları → `{ alan: mesaj }`.
 *
 * Zarf: `details.errors[] = { loc: ["body","customer","budget_amount"], msg }`.
 * `loc`'un ilk parçası taşıyıcıdır (body/query/path), son parçası alan adı.
 * Formlar bunu kendi alan adlarıyla eşleyip hatayı ilgili girdinin altında
 * gösterebilir — hata kutusunda kaybolmasın.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const body = err.body;
  if (!body || typeof body !== 'object') return {};
  const details = (body as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return {};
  const list = (details as { errors?: unknown }).errors;
  if (!Array.isArray(list)) return {};

  const out: Record<string, string> = {};
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { loc, msg } = item as { loc?: unknown; msg?: unknown };
    if (typeof msg !== 'string' || !Array.isArray(loc) || loc.length === 0) continue;
    const parts = loc.filter((p): p is string => typeof p === 'string');
    const field = parts[parts.length - 1];
    if (!field) continue;
    // Aynı alan birden çok kez gelirse ilk mesaj korunur.
    if (!(field in out)) out[field] = msg;
  }
  return out;
}

export function networkLabel(): string {
  return stellarConfig.network === 'mainnet' ? 'Mainnet (Public)' : 'Testnet';
}
