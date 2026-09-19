/**
 * Cüzdan soyutlaması. Web'de Stellar Wallets Kit (Freighter, xBull, Albedo, Lobstr…),
 * mobilde WalletConnect v2 / Freighter mobile (sprint görevi — şu an stub).
 * Uygulamanın geri kalanı yalnızca bu arayüzü bilir.
 */
export interface WalletAdapter {
  /** Platformda cüzdan bağlantısı mümkün mü (ör. web'de her zaman true). */
  readonly available: boolean;
  /** Cüzdan seçim akışını açar ve bağlanan adresi (G…) döner. */
  connect(): Promise<{ address: string; walletId?: string }>;
  disconnect(): Promise<void>;
  /** Kit hafızasındaki bağlı adres; bağlı değilse null. */
  getAddress(): Promise<string | null>;
  /** XDR imzalar (SEP-10 challenge ve Soroban işlemleri dâhil). */
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<string>;
  /** Soroban auth entry imzalar (çok taraflı yetkilendirme). */
  signAuthEntry?(
    authEntryXdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<string>;
}

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code:
      'NOT_AVAILABLE' | 'NOT_CONNECTED' | 'USER_REJECTED' | 'WRONG_NETWORK' | 'UNKNOWN' = 'UNKNOWN',
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
