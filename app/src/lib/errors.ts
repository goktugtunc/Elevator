import { ApiError } from '@/lib/api/client';
import { Sep10Error } from '@/lib/auth/sep10';
import { stellarConfig } from '@/lib/stellar/config';
import { WalletError } from '@/lib/wallet/types';

/**
 * Hata → kullanıcıya gösterilecek Türkçe metin (tek kaynak).
 * Ekranlar hata nesnesini yorumlamaz, bu fonksiyonu çağırır; böylece
 * "yanlış ağ", "imza reddedildi", "sunucuya ulaşılamadı" her yerde aynı okunur.
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
        return err.message;
      case 'NOT_CONNECTED':
        return 'No wallet connected. Connect a wallet first.';
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
    switch (err.status) {
      case 0:
        return 'Could not reach the server. Is the backend running? (EXPO_PUBLIC_API_BASE_URL)';
      case 401:
        return 'Your session could not be verified or has expired. Sign in again with your wallet.';
      case 403:
        return 'You are not allowed to do that.';
      case 404:
        return 'Not found.';
      case 409:
        // Sunucu hangi alanın çakıştığını söylüyor (`code`, `message`);
        // bunu genel bir cümleyle değiştirmek kullanıcıyı körleştiriyordu.
        if (err.code === 'username_taken') return 'That username is already taken.';
        return err.message || 'This wallet or username is already registered.';
      case 400:
      case 422:
        return err.message; // sunucunun alan bazlı mesajı
      case 429:
        return 'Too many requests. Wait a moment and try again.';
      default:
        return err.status >= 500 ? `Server error (${err.status}). Please try again.` : err.message;
    }
  }

  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export function networkLabel(): string {
  return stellarConfig.network === 'mainnet' ? 'Mainnet (Public)' : 'Testnet';
}
