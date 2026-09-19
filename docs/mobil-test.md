# Mobil test (Expo Go + iOS simülatörü)

Uygulama Expo Go ile çalışacak şekilde yazıldı: özel native modül yok
(rastgelelik `expo-crypto`, pano `expo-clipboard`, QR `react-native-qrcode-svg`).
Bu yüzden development build gerekmez.

## 0. Ön koşullar

| Gereken | Neden | Durum |
|---|---|---|
| `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect eşleşmesi bu kimlik olmadan başlamaz | ⬜ doldurulmalı — ücretsiz: <https://cloud.reown.com> |
| Xcode (App Store) | iOS simülatörü ve `simctl` yalnızca Xcode ile gelir | ⬜ bu makinede yalnızca Command Line Tools var |
| Lobstr ya da xBull (gerçek telefon) | Simülatöre App Store uygulaması kurulamaz; imzayı gerçek cüzdan atar | ⬜ |

Kontrol:

```bash
xcrun simctl list devices available | head   # Xcode kuruluysa cihazları listeler
grep WALLETCONNECT app/.env                  # değer dolu olmalı
```

## 1. Xcode kurulumu (tek seferlik)

1. App Store → **Xcode** → kur (~10 GB, sürer).
2. Kurulum bitince bir kez aç, lisansı kabul et.
3. Komut satırı araçlarını Xcode'a yönlendir:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -downloadPlatform iOS        # iOS simülatör runtime'ı
   ```

## 2. Uygulamayı simülatörde açmak

```bash
cd app
npm install
npx expo start --ios     # Expo Go'yu simülatöre kendisi kurar ve açar
```

Beklenen: Onboarding → Sign in ekranı. Sunucu satırında
`Server connected · mobilback.yolalapp.com` görünmeli.

## 3. Cüzdan bağlantısı — simülatör + gerçek telefon

Simülatöre Lobstr/xBull kurulamaz (App Store uygulamaları simülatörde çalışmaz),
bu yüzden deep link butonları simülatörde iş görmez. **QR yolu çalışır:**

1. Simülatörde **Connect wallet**'a bas.
2. Açılan sheet'te QR kodu çıkar (bu, WalletConnect eşleşme URI'sidir —
   QR'ın çıkması handshake'in başladığını kanıtlar).
3. Telefondaki **Lobstr → Settings → WalletConnect** (ya da xBull → WalletConnect)
   ile QR'ı okut, bağlantıyı onayla.
4. Simülatörde adres görünür; ardından SEP-10 imza isteği telefona düşer.

Gerçek telefonda test (deep link dâhil): `npx expo start` → QR'ı **Expo Go**
ile okut → "Connect wallet" → "Open in Lobstr".

## 4. Bilinen sınırlar

- SEP-10 girişi backend'in `/api/v1/auth/*` uçları açılana kadar hata gösterir
  (BE-02). Cüzdan bağlantısının kendisi backend'den bağımsız çalışır.
- Cüzdan **Testnet**'te olmalı; değilse "wallet is on a different network" uyarısı çıkar.
- Expo Go'ya yeni bir native bağımlılık eklenirse (ör. `react-native-quick-crypto`)
  bu akış kırılır ve development build gerekir.
