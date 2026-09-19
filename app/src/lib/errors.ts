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
        return 'İmza isteği cüzdanda reddedildi. Girişi tamamlamak için isteği onayla.';
      case 'WRONG_NETWORK':
        return `Cüzdanın farklı bir ağda. Cüzdanını ${networkLabel()} ağına al ve tekrar dene.`;
      case 'NOT_AVAILABLE':
        return err.message;
      case 'NOT_CONNECTED':
        return 'Cüzdan bağlı değil. Önce cüzdanını bağla.';
      default:
        return err.message || 'Cüzdan hatası.';
    }
  }

  if (err instanceof Sep10Error) {
    switch (err.code) {
      case 'WRONG_NETWORK':
        return `Sunucu ile cüzdan aynı ağda değil. Uygulama ${networkLabel()} ağında çalışıyor.`;
      case 'EXPIRED_CHALLENGE':
        return 'Giriş isteğinin süresi doldu. Tekrar dene.';
      case 'ADDRESS_MISMATCH':
        return 'Giriş isteği başka bir cüzdan adresi için üretilmiş. Cüzdanını kontrol et.';
      default:
        return err.message;
    }
  }

  if (err instanceof ApiError) {
    switch (err.status) {
      case 0:
        return `Sunucuya ulaşılamadı. Backend çalışıyor mu? (EXPO_PUBLIC_API_BASE_URL)`;
      case 401:
        return 'Oturum doğrulanamadı ya da süresi doldu. Cüzdanınla tekrar giriş yap.';
      case 403:
        return 'Bu işlem için yetkin yok.';
      case 404:
        return 'Kayıt bulunamadı.';
      case 409:
        return 'Bu cüzdan ya da kullanıcı adı zaten kayıtlı.';
      case 400:
      case 422:
        return err.message; // sunucunun alan bazlı mesajı
      case 429:
        return 'Çok fazla istek gönderildi. Biraz bekleyip tekrar dene.';
      default:
        return err.status >= 500
          ? `Sunucu hatası (${err.status}). Lütfen tekrar dene.`
          : err.message;
    }
  }

  if (err instanceof Error) return err.message;
  return 'Bilinmeyen bir hata oluştu.';
}

export function networkLabel(): string {
  return stellarConfig.network === 'mainnet' ? 'Mainnet (Public)' : 'Testnet';
}
