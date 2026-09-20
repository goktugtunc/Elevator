# Elevator: Geliştirme Notları (Güncel)

Kaynak: Risein Stellar Pro Hackathon görev sayfaları (Submission Criteria, Judging Criteria, Developer Resources, Track sayfaları). Tasarım: Figma (`6ZxzvsYKarDglg0PGYRIgP`). Yalnızca teknik alanlar ele alınmıştır.

---

## 1. Temel kararlar ve eski notlardan farklar

- Ağ **Stellar Testnet** (eski notlardaki `stellar:pubnet` kaldırıldı). Tüm kontratlar **Soroban SDK** ile yazılır ve Testnet'e deploy edilir.
- **Anchor kullanımı zorunlu** ve jüri kriterinde en yüksek ağırlıklı alan (SEP standartlarıyla TRY ↔ Stellar varlıkları gibi gerçek bir anchor/yerel ödeme akışı).
- Jüri, **herkese açık çalışan bir demo ve uygulama URL'si** istiyor. Bu yüzden birincil hedef **Expo Web**, mobil ikincildir.
- Veri **mock veya hardcoded olmamalı**. Core akışlar Testnet'te uçtan uca çalışmalı.
- Giriş için `stellar_signMessage` yerine **SEP-10** kullanılır (anchor zaten ister).
- Passkey ve akıllı cüzdan **bonus**, zorunlu değil.

---

## 2. Ortak sözleşme (Frontend + Backend)

- **Kontrat arayüzü:** Backend fonksiyon imzalarını ve event'leri baştan yayınlar. Deploy sonrası Stellar CLI ile üretilen **typed bindings** frontend'e verilir.
- **API sözleşmesi:** Backend OpenAPI dosyası veya sabit endpoint listesi yayınlar. Frontend endpoint'ler hazır olana kadar geçici veri kullanabilir. Nihai teslimde sahte veri kalmaz.
- **Ortam değişkenleri:** Kontrat ID'leri, anchor domain'i, RPC/Horizon URL'leri, Relayer adresi ve API base URL tek bir `.env` şablonunda tutulur.
- **Auth akışı:** SEP-10 challenge, imza, JWT sırası baştan yazılır.
- **Rol modeli:** `trader` ve `customer`, kayıtta seçilir.
- **Repo yapısı önerisi:** Monorepo (`/contracts`, `/backend`, `/app`).

---

## 3. Backend

### 3.1 Soroban kontratları
- Trader kaydı ve ilan: oluşturma, güncelleme, listeleme, kapatma.
- Kiralama sözleşmesi ve escrow: teklif, kabul, kilitleme, sonuçlanma, iade, ödeme (Mesajlar ve Sözleşme ekranının zincir üstü karşılığı).
- Ücret ve ödeme mantığı.
- Soroban auth (`require_auth`) ve storage türlerinin (persistent, instance, temporary) bilinçli seçimi.
- Birim testleri, Testnet deploy, kontrat ID'lerinin belgelenmesi.
- Frontend'in tüketeceği event'ler: ilan açıldı, sözleşme kabul edildi, ödeme yapıldı.

### 3.2 Kimlik doğrulama sunucusu
- SEP-10 challenge üretimi ve imza doğrulama, JWT oturumu.
- Kayıtta rol kaydı, cüzdan adresine bağlanır.
- Korumalı endpoint'ler JWT ile çalışır.

### 3.3 Anchor entegrasyonu
- SEP-1: `stellar.toml` keşfi.
- SEP-10: kimlik doğrulama.
- SEP-24 (veya SEP-6): TRY yatırma ve çekme. Interactive URL frontend'e döner.
- SEP-12: KYC, anchor isterse.
- İşlem durumu takibi ve Hareketler için kayıt.
- Anchor anahtarları yalnızca sunucuda kalır.
- Testnet'te TRY anchor yoksa Testnet anchor ile aynı SEP akışı uygulanır ve TRY olarak sunulur.

### 3.4 İşlem gönderimi
- **OpenZeppelin Relayer** ile ücret sponsorluğu ve işlem gönderimi (Launchtube kapatıldı).
- Frontend imzalı XDR'ı backend'e gönderir, backend Relayer/RPC ile iletir. Kullanıcı anahtarı backend'e gelmez.

### 3.5 İndeksleyici ve veri katmanı
- Stellar RPC event'leri ve Horizon verisi okunup veritabanına yazılır.
- Keşfet, İlanlarım ve Hareketler bu veriden beslenir.
- Veritabanı: kontrat yansıması, profiller, mesajlar, bildirimler, anchor işlem kayıtları.

### 3.6 API uç noktaları (özet)
- `POST /auth/challenge`, `POST /auth/verify`
- `GET /profile`, `POST /register`
- `GET /listings`, `GET /listings/:id`, `GET /my/listings`
- `POST /follow`, `GET /follows`
- `GET /contracts`, `GET /contracts/:id`
- `GET /transactions`
- `POST /anchor/deposit`, `POST /anchor/withdraw`, `GET /anchor/status/:id`
- `POST /tx/submit` (imzalı XDR)
- `GET /messages`, `POST /messages`, `GET /notifications`

---

## 4. Frontend

### 4.1 Proje ve dağıtım
- Expo + React Native. **Birincil hedef Expo Web** (`react-native-web`), herkese açık URL'ye deploy.
- İkincil hedef mobil: `expo-dev-client` + EAS Build. `app.json` içinde benzersiz `scheme` (`elevator`).
- Expo Go yalnızca cüzdansız arayüz ekranları için. Cüzdanlı işler development build'de veya web'de test edilir.
- Hedef sürüm Expo SDK 57 (eski notlardan gelen bilgi, Risein'de yok, kurulumdan önce doğrulanmalı).

### 4.2 Cüzdan bağlantısı
- Web: Freighter uzantısı, **Stellar Wallets Kit**.
- Mobil: Freighter mobile + WalletConnect v2 (`UniversalProvider`). Desteklenen yöntemler: `stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signMessage`, `stellar_signAuthEntry`. Polyfill: `react-native-get-random-values`, Buffer.
- Giriş ekranı: Freighter birincil, WalletConnect (QR) ikincil, Freighter yoksa "Freighter'ı indir". MetaMask, Coinbase ve Trust kalkar.
- Belgelenmemiş riskler (zaman sınırıyla prototiple test edilir):
  - RN/Expo'dan Freighter'a WalletConnect bağlantısı.
  - Uygulama → cüzdan → uygulama deep link dönüşü.
  - Web WalletConnect modal'ının RN karşılığı.
  - Stellar Wallets Kit'in mobil/RN desteği.
- Prototip başarısız olursa web ile devam edilir. Yedekler: Blux, Privy, Dfns.

### 4.3 Auth ve işlem akışı
- Backend'den SEP-10 challenge alınır, cüzdanla imzalanır, JWT saklanır. Rol seçimi kayıtta yapılır.
- Bindings ile kontrat çağrısı hazırlanır ve simüle edilir, kullanıcı imzalar, imzalı XDR `POST /tx/submit`'e gider.
- İşlem durumu (gönderildi, onaylandı, başarısız) arayüzde gösterilir.

### 4.4 Anchor arayüzü
- "TRY Yatır" / "Çek" aksiyonları backend'den interactive URL alır ve webview/popup'ta açar. İşlem bitince durum sorgulanır, bakiye yenilenir.

### 4.5 Ekranlar (öncelik sırasıyla)
1. Giriş ve kayıt (rol seçimi)
2. Keşfet (kaydırmalı, müşteri için "Takip Et")
3. Mesajlar ve Sözleşme
4. Panel
5. Hareketler
6. İlanlarım
7. Profil ve Cüzdan (bakiye, yatırma/çekme)
8. Bildirimler (en sona)

---

## 5. Birleşme noktaları

| Frontend'in beklediği | Backend'in vereceği | Ne zaman |
|---|---|---|
| Kontrat imzaları | İmza dosyası | Baştan |
| Typed bindings paketi | CLI ile üretim | Kontrat ilk deploy'da |
| OpenAPI / endpoint listesi | Yayınlanmış şema | Baştan |
| `.env` değerleri | Kontrat ID'leri, URL'ler | İlk deploy'da |
| SEP-10 akışı | `/auth/*` | Erken |
| Anchor interactive URL | `/anchor/*` | Çekirdek akış öncesi |
| İmzalı XDR gönderimi | `/tx/submit` | Çekirdek akış öncesi |

**Çekirdek akış (uçtan uca doğrulama):** giriş ve rol → ilan → TRY yatırma → sözleşme ve escrow → ödeme → çekim. Doğrulama araçları: Stellar Lab, Stellar.Expert. Faucet: Circle USDC/EURC Testnet.

---

## 6. Dokümantasyon (README'de olması gerekenler)

- Genel mimari ve **Mermaid diyagramı**.
- Bileşenler ve sorumlulukları.
- Kullanılan Stellar entegrasyonları ve protokoller (SEP'ler, Relayer, RPC).
- Tasarım kararları ve ödünleşimler.
- Teknik zorluklar ve çözümleri.
- Kontrat ID'leri ve deploy çıktıları.
- Kurulum, test ve değerlendirme adımları.
- İlgili Stellar Skills referansları.
- Public GitHub reposu.

---

## 7. Teknik jüri kriterleri ve eşleme

| Kriter | Karşılığı |
|---|---|
| Testnet'te gerçek işlevsellik | Mock yok, veri zincirden veya anchor'dan |
| Uçtan uca çalışan akış | Çekirdek akış kırılmadan çalışmalı |
| Soroban auth ve storage | `require_auth`, doğru storage türleri |
| Mimari ve dokümantasyon | Mermaid + README |
| Ecosystem Fit (en ağır) | Anchor SEP'leri, Relayer, CLI, bindings |
| Kullanıcı deneyimi | Kripto bilmeyen biri için sade akış, tutarlı navigasyon |

---

## 8. Karar verilmemiş konular

### Ortak
1. **Takip ve Mesajlar nerede tutulacak?** Zincir dışı (veritabanı) veya zincir üstü. Öneri: zincir dışı, sözleşme ve escrow zincir üstünde.
2. **Testnet'te TRY anchor var mı?** Risein'de belirtilmemiş. Mentörlere sorulmalı.
3. **Hangi SEP'ler?** SEP-24 mü SEP-6 mı, SEP-12 gerekli mi? Seçilen anchor'ın desteğine bağlı.
4. **Repo yapısı.** Monorepo (öneri) veya ayrı repolar.
5. **API sözleşmesi biçimi.** OpenAPI dosyası veya sabit endpoint listesi.
6. **Rol modeli detayı.** Bir cüzdan hem Trader hem Müşteri olabilir mi, yoksa rol bir kez mi seçilir?
7. **Track seçimi.** Büyük olasılıkla Genesis, teyit edilmeli. Scale olursa Mermaid diyagramı zorunlu.

### Backend
8. **Kontrat kapsamı.** Escrow mantığı (teklif, kabul, kilitleme, sonuçlanma, iade), ücret yapısı, trader performansının kontratta nasıl ölçüleceği.
9. **Backend teknolojisi ve barındırma.** Dil/çerçeve, veritabanı, deploy yeri.
10. **İndeksleyici yaklaşımı.** RPC event'leri mi Horizon mu?
11. **Ücret sponsorluğu kapsamı.** Relayer ile hangi işlemler sponsor edilecek.
12. **Oturum saklama.** JWT süresi ve yenileme yöntemi.

### Frontend
13. **Mobil cüzdan bağlantısı.** Prototipe ayrılacak süre ve başarısızlıkta yalnızca web teslimi.
14. **Expo SDK sürümü.** SDK 57 doğrulanmalı.
15. **Web deploy platformu.** Vercel, Netlify veya EAS Hosting.
16. **Anchor arayüzünün açılış biçimi.** Webview, popup veya yeni sekme.
17. **Yedek cüzdan altyapısı.** Stellar Wallets Kit, Blux, Privy veya Dfns.
18. **Passkey / akıllı cüzdan.** Bonus özellik olarak yapılıp yapılmayacağı.

---

## 9. Kaynaklar

- Risein: Developer Resources, Submission Criteria, Judging Criteria, Genesis/Scale Track sayfaları
- Freighter mobile WalletConnect: https://docs.freighter.app/mobile-walletconnect/connecting
- Freighter mobile repo: https://github.com/stellar/freighter-mobile
- Stellar cüzdan seçenekleri: https://developers.stellar.org/docs/tools/developer-tools/wallets
- Stellar Wallets Kit: https://stellarwalletskit.dev/wallet-connect/
- Expo SDK 57 changelog: https://expo.dev/changelog/sdk-57
