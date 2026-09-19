# Mobil test (Expo Go + iOS simülatörü)

Uygulama Expo Go ile çalışacak şekilde yazıldı: özel native modül yok
(rastgelelik `expo-crypto`, pano `expo-clipboard`, QR `react-native-qrcode-svg`).
Bu yüzden development build gerekmez.

## 0. Ön koşullar

| Gereken | Neden | Durum |
|---|---|---|
| `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect eşleşmesi bu kimlik olmadan başlamaz | ⬜ doldurulmalı — ücretsiz: <https://cloud.reown.com> |
| Xcode (App Store) | Yalnızca simülatör için gerekir; Expo Go yolu Xcode istemez | ⬜ bu makinede yalnızca Command Line Tools var |
| Lobstr ya da xBull (telefonda) | İmzayı gerçek cüzdan atar | ⬜ |
| Expo Go (telefonda) | Uygulamayı derlemeden çalıştırır | ⬜ App Store / Play Store |

Kontrol:

```bash
xcrun simctl list devices available | head   # Xcode kuruluysa cihazları listeler
grep WALLETCONNECT app/.env                  # değer dolu olmalı
```

## 1. Telefonda Expo Go ile açmak (birincil yol)

```bash
cd app
npm install
npx expo start            # terminalde QR çıkar
```

- Telefon ve Mac **aynı Wi-Fi ağında** olmalı. Değilse: `npx expo start --tunnel`.
- iOS: Kamera uygulamasıyla QR'ı okut → Expo Go açılır.
- Android: Expo Go → "Scan QR code".
- Elle adres: `exp://<Mac-IP>:8081` (ör. `exp://192.168.1.29:8081`).

Cüzdan bağlantısı burada tam çalışır: "Connect wallet" → "Open in Lobstr/xBull"
telefondaki cüzdanı açar, onaydan sonra Expo Go'ya döner (dönüş adresi
`Linking.createURL('/')` ile Expo Go'ya göre üretilir).

## 2. Xcode kurulumu (isteğe bağlı, simülatör için)

1. App Store → **Xcode** → kur (~10 GB, sürer).
2. Kurulum bitince bir kez aç, lisansı kabul et.
3. Komut satırı araçlarını Xcode'a yönlendir:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -downloadPlatform iOS        # iOS simülatör runtime'ı
   ```

## 3. Uygulamayı simülatörde açmak

```bash
cd app
npm install
npx expo start --ios     # Expo Go'yu simülatöre kendisi kurar ve açar
```

Beklenen: Onboarding → Sign in ekranı. Sunucu satırında
`Server connected · mobilback.yolalapp.com` görünmeli.

## 4. Cüzdan bağlantısı — simülatör + gerçek telefon

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

## 5. Bilinen sınırlar

- SEP-10 girişi backend'in `/api/v1/auth/*` uçları açılana kadar hata gösterir
  (BE-02). Cüzdan bağlantısının kendisi backend'den bağımsız çalışır.
- Cüzdan **Testnet**'te olmalı; değilse "wallet is on a different network" uyarısı çıkar.
- Expo Go'ya yeni bir native bağımlılık eklenirse (ör. `react-native-quick-crypto`)
  bu akış kırılır ve development build gerekir.
- Expo Go'da uygulamanın kendi scheme'i (`traderkirala://`) kayıtlı değildir; dönüş
  adresi bu yüzden `Linking.createURL('/')` ile üretilir (Expo Go'da `exp://.../--/`).
