/**
 * Cüzdan soyutlaması. Web'de Stellar Wallets Kit (Freighter, xBull, Albedo, Lobstr…),
 * mobilde WalletConnect v2 (Lobstr, xBull gibi Stellar cüzdanları).
 * Uygulamanın geri kalanı yalnızca bu arayüzü bilir.
 */
export interface ConnectOptions {
  /**
   * Mobilde eşleşme URI'si hazır olduğunda çağrılır (QR ya da cüzdan deep link'i
   * için). Web adaptörü kendi modalını açtığından bunu kullanmaz.
   */
  onUri?: (uri: string) => void;
  /**
   * Native tarafta hangi imza yolu kullanılacak: uygulama içi cüzdan ya da
   * WalletConnect. Verilmezse son seçilen yol sürer.
   */
  mode?: 'local' | 'walletconnect';
}

export interface WalletAdapter {
  /** Platformda cüzdan bağlantısı mümkün mü (ör. web'de her zaman true). */
  readonly available: boolean;
  /** Cüzdan bağlantısını başlatır ve bağlanan adresi (G…) döner. */
  connect(options?: ConnectOptions): Promise<{ address: string; walletId?: string }>;
  disconnect(): Promise<void>;
  /** Kayıtlı oturumdaki adres; bağlı değilse null. */
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
      | 'NOT_AVAILABLE'
      | 'NOT_CONNECTED'
      | 'USER_REJECTED'
      | 'WRONG_NETWORK'
      | 'MISSING_CONFIG'
      | 'UNKNOWN' = 'UNKNOWN',
  ) {
    super(message);
    this.name = 'WalletError';
  }
}
