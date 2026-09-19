# Sprint 1 — Frontend (app/)

**Başlangıç:** 19 Eyl 2026 · **Bitiş:** _hackathon teslim tarihine göre doldurulacak_ · **Kapsam:** yalnızca `app/` (Expo Web birincil, mobil ikincil)

**Sprint hedefi:** Jürinin herkese açık URL'den açıp cüzdanla girip, rol seçip, ilan keşfedip sözleşme akışını uçtan uca görebildiği bir Expo Web uygulaması. Backend/kontrat hazır olana kadar ekranlar API katmanına yazılır; nihai teslimde sahte veri kalmaz.

## Kurulum durumu (hazır)

- [x] Expo SDK 57 + TypeScript + expo-router (typed routes), Inter fontları, ESLint/Prettier
- [x] Tema token'ları Figma DS ile birebir (`src/theme`) — bkz. `docs/design-system.md`
- [x] UI kütüphanesi: Button, Chip, Pill, RiskBadge, StatusChip, KpiBox/Stat, Avatar, Segmented, Field, ListRow, Card; layout: Screen, TopBar/ScreenHeader, TabBar (rol bazlı), RiskStrip, Placeholder
- [x] Navigasyon iskeleti: `(auth)` → rol bazlı `(customer)` / `(trader)` tab grupları + paylaşılan stack ekranları; `app/index.tsx` oturuma göre yönlendirir
- [x] Cüzdan adaptörü: web = Stellar Wallets Kit v2 (modal çalışıyor), native = stub (FE-13)
- [x] `@stellar/stellar-sdk` 17 (RPC/Horizon istemcileri, polyfill'ler), SEP-10 giriş akışı (`lib/auth/sep10.ts`), oturum store'u (zustand + SecureStore/localStorage)
- [x] API istemcisi + notlardaki tüm endpoint'ler tiplenmiş (`lib/api/endpoints.ts`), `.env.example`
- [x] Onboarding (1a–1c), Giriş (1d), Rol Seçimi (1e) ekranları çalışır durumda
- [x] `npm run typecheck`, `npm run lint`, `npm run export:web` temiz geçiyor

## Definition of Done (her ekran görevi için)

1. Figma frame'iyle piksel değil ama **yapı ve metin** olarak birebir (Türkçe metinler Figma'dan kopyalanır).
2. Veri `src/lib/api` üzerinden gelir; bileşen içinde sabit veri yok. Endpoint hazır değilse `Placeholder` yerine **boş/yükleniyor/hata durumu** gösterilir.
3. Web'de (Chrome, 390px genişlik) ve mümkünse Expo Go'da (cüzdansız ekranlar) kontrol edilmiş.
4. `npm run check` temiz; PR'da Figma node linki var.
5. Her ekranda Risk Strip görünür.

## Görevler

Öncelik = gelistirme-notlari §4.5 sırası. Tahmin: S ≤ ½ gün · M ≈ 1 gün · L ≈ 2 gün. `Bağımlılık` sütunundaki BE-* maddeleri backend ekibinden beklenir.

| ID | Görev | Figma | Tahmin | Bağımlılık | Sahip | Durum |
|---|---|---|---|---|---|---|
| FE-01 | ~~Proje kurulumu, tema, UI kit, navigasyon iskeleti~~ | DS 0:1 | L | — | Claude | ✅ |
| FE-02 | ~~Onboarding + Giriş (cüzdan) + Rol Seçimi~~ | 19:13 · 19:109 · 19:181 | M | — | Claude | ✅ |
| FE-03 | ~~Kayıt · Bilgiler formu (Müşteri / Trader varyantı), `session.register()` bağlantısı~~ | 19:269 · 19:353 | M | BE-01 (`POST /register`) | Claude | ✅ |
| FE-04 | SEP-10 istemci tarafı: challenge doğrulama, JWT süresi/401 yenileme, hata mesajları (yanlış ağ, reddedilen imza) | 19:109 | S | BE-02 (`/auth/*`) | Claude | 🟡 |
| FE-05 | Keşfet · kaydırmalı deck (gesture-handler + reanimated): kart bileşeni, sağa kaydırma = Teklif İste / Ver, sola = Geç, Takip Et/Kaydet | 21:30 · 21:282 | L | — (UI), BE-03 (`GET /listings`) | | ⬜ |
| FE-06 | Keşfet · Trader varyantı + "Teklif Ver" bottom sheet (Komisyon, getiri aralığı, not) | 21:160 · 21:414 | M | FE-05 | | ⬜ |
| FE-07 | Bottom Sheet + Switch + Progress ortak bileşenleri (Yeni İşlem, Görünümü Düzenle, Teklif Ver tarafından kullanılır) | 23:181 · 30:536 | S | — | | ⬜ |
| FE-08 | Mesajlar listesi + Sohbet ekranı | 28:171 · 28:266 | M | BE-04 (`/messages`) | | ⬜ |
| FE-09 | Sözleşme ekranı + "Onaylamak için kaydır" → escrow kontrat çağrısı (bindings, simulate, imza, `POST /tx/submit`), işlem durumu UI'ı (gönderildi/onaylandı/başarısız, stellar.expert linki) | 28:320 | L | BE-05 (bindings + kontrat ID), BE-06 (`/tx/submit`) | | ⬜ |
| FE-10 | Panel · Müşteri (portföy KPI + sparkline, takip listesi, ilan etkileşimleri) | 30:97 | M | BE-03, BE-07 (`/contracts`, `/follows`) | | ⬜ |
| FE-11 | Panel · Trader (profil tamamlama, bekleyen teklifler, aktif yatırımcılar) | 23:362 | M | BE-03, BE-07 | | ⬜ |
| FE-12 | Hareketler · birleşik akış + trader bazlı görünüm + "Görünümü Düzenle" sheet | 30:252 · 30:375 · 30:536 | M | FE-07, BE-08 (`/transactions`) | | ⬜ |
| FE-13 | **Mobil cüzdan prototipi (timebox 1 gün):** Freighter mobile + WalletConnect v2 `UniversalProvider`, deep link dönüşü; başarısızsa web-only karar verilir | — | M | `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` | | ⬜ |
| FE-14 | İşlemler · Trader (K/Z başlığı, açık/geçmiş) + "Yeni İşlem" sheet → `tradesApi.create` | 23:45 · 23:181 | M | FE-07, BE-08 | | ⬜ |
| FE-15 | İlanlarım (iki rol) + İlan Detayı (teklifler/talepler/ilgi sekmeleri) | 26:58 · 26:203 · 26:345 · 26:462 | M | BE-03 | | ⬜ |
| FE-16 | İlan Oluştur sihirbazı (4 adım; risk profili adımı Figma'da) → `listingsApi.create` + zincir üstü ilan kaydı | 28:106 | M | BE-05 | | ⬜ |
| FE-17 | Trader Profili (KPI grid, performans segmented + sparkline, canlı hareketler, strateji, yorumlar) | 22:171 | M | BE-03, BE-08 | | ⬜ |
| FE-18 | Profil (iki rol) + Cüzdan (Horizon bakiye, TRY Yatır/Çek → SEP-24 interactive URL `expo-web-browser`, durum sorgusu, son işlemler) | 27:436 · 27:569 · 27:699 | L | BE-09 (`/anchor/*`) | | ⬜ |
| FE-19 | Bildirimler (liste, gruplar, tümünü oku, boş durum) | 27:96 · 27:240 · 27:371 | S | BE-10 (`/notifications`) | | ⬜ |
| FE-20 | Sparkline bileşeni (react-native-svg) — Panel, Keşfet kartı, Trader Profili | — | S | — | | ⬜ |
| FE-21 | Web deploy (Vercel / Netlify / EAS Hosting — karar §8.15) + `.env` production değerleri + herkese açık URL | — | S | BE-05 | | ⬜ |
| FE-22 | README: kurulum, test adımları, ekran görüntüleri, Stellar entegrasyon listesi; Mermaid diyagramı güncel | — | S | — | | ⬜ |
| FE-23 | Uçtan uca demo provası: giriş → ilan → yatırma → sözleşme → ödeme → çekim (Testnet, gerçek veri) | — | M | tüm BE-* | | ⬜ |

**FE-03 notu:** Form, doğrulama ve `session.register()` bağlantısı hazır; gövde şeması `lib/api/endpoints.ts` içinde `CustomerRegisterPayload` / `TraderRegisterPayload` olarak tiplendi ve BE-01 için öneri niteliğinde. Backend ayağa kalkınca gerçek `POST /register` ile uçtan uca denenecek; şu an hata durumu ekranda gösteriliyor.

**FE-04 notu (🟡 = istemci hazır, BE-02 bekleniyor):** Challenge imzalanmadan önce doğrulanıyor (sequence 0, zaman aralığı, istemci hesabına ait `manageData`, ağ passphrase'i). JWT'nin `exp` claim'i okunup saklanıyor; süresi dolmuş token'la açılışta girişe düşülüyor. 401 gelen her istek `registerAuthBridge` üzerinden bir kez SEP-10 yenilemesi deniyor (SEP-10'da refresh token yok → cüzdanda imza isteği açılır), başarısızsa oturum kapanıp giriş ekranında uyarı gösteriliyor. Hata metinleri tek kaynakta: `src/lib/errors.ts`. Gerçek `/auth/challenge` + `/auth/verify` ile uçtan uca doğrulama BE-02 ayağa kalkınca yapılacak.

Backend'e bağımlı olmayan, hemen başlanabilecek işler: **FE-05, FE-07, FE-13, FE-20** ve tüm ekranların UI katmanı (veri bağlantısı sonra).

## Backend'den beklenenler (birleşme noktaları)

| ID | Ne | Nereye | Ne zaman |
|---|---|---|---|
| BE-01 | `POST /register` şeması (rol + form alanları) | `lib/api/endpoints.ts` | Sprint başı |
| BE-02 | `/auth/challenge`, `/auth/verify` çalışır (SEP-10, Testnet passphrase) | `lib/auth/sep10.ts` | Erken |
| BE-03 | `/listings*`, `/my/listings` | `listingsApi` | Keşfet öncesi |
| BE-04 | `/messages*` | `messagesApi` | Mesajlar öncesi |
| BE-05 | Kontrat ID'leri + typed bindings paketi | `src/lib/stellar/bindings/`, `.env` | İlk deploy |
| BE-06 | `POST /tx/submit` (Relayer) | `txApi` | Sözleşme öncesi |
| BE-07 | `/contracts*`, `/follow*` | `contractsApi`, `followApi` | Panel öncesi |
| BE-08 | `/transactions` (+ `POST` trader için) | `tradesApi` | Hareketler öncesi |
| BE-09 | `/anchor/deposit|withdraw|status` (SEP-24 interactive URL) | `anchorApi` | Cüzdan öncesi |
| BE-10 | `/notifications` | `notificationsApi` | Sona |

## Riskler ve kararlar

- **Mobil cüzdan (FE-13):** RN/Expo'dan Freighter'a WalletConnect bağlantısı belgelenmemiş; 1 günlük timebox, başarısızsa mobil teslim cüzdansız ekranlarla sınırlı, birincil hedef web. Yedekler: Blux, Privy, Dfns.
- **Stellar Wallets Kit npm paketi** (`@creit.tech/stellar-wallets-kit` 2.6) kullanılıyor; bakımcılar npm güncellemelerini durdurabilir → gerekirse `npx jsr add @creit-tech/stellar-wallets-kit`'e geçiş (import yolları aynı).
- **TRY anchor Testnet'te yok** ise Testnet anchor ile aynı SEP-24 akışı TRY etiketiyle sunulur (§3.3). Mentörlere sorulacak.
- **Rol modeli:** bir cüzdan tek rol mü? (§8.6) Şu an `index.tsx` tek rol varsayar; iki rol olursa rol değiştirici Profil'e eklenir.
- **Sahte veri yasağı:** geliştirme sırasında geçici veri yalnızca `lib/api` altında, `__DEV__` koşuluyla ve `TODO(remove-before-submit)` etiketiyle tutulur.

## Ritüeller

- Günlük 10 dk senkron: bloklayan BE-* maddeleri.
- Her ekran ayrı PR; PR başlığında görev ID'si (`FE-05 Keşfet deck`).
- Sprint sonu: FE-23 demo provası kayıt altına alınır (ekran kaydı → README).
