# Sprint 1 — Frontend (app/)

**Başlangıç:** 19 Eyl 2026 · **Bitiş:** _hackathon teslim tarihine göre doldurulacak_ · **Kapsam:** yalnızca `app/` (Expo Web birincil, mobil ikincil)

**Sprint hedefi:** Jürinin herkese açık URL'den açıp cüzdanla girip, rol seçip, ilan keşfedip sözleşme akışını uçtan uca görebildiği bir Expo Web uygulaması. Backend/kontrat hazır olana kadar ekranlar API katmanına yazılır; nihai teslimde sahte veri kalmaz.

## Backend

**Canlı ve tamamlandı:** <https://mobilback.yolalapp.com> — _TraderKirala API 1.0.0_, **92 uç**.
Şema: `/docs` · `/openapi.json`. Backend ayrı bir depoda geliştiriliyor; bu repoda `backend/` klasörü yok.

- **Base URL:** `https://mobilback.yolalapp.com/api/v1` (`.env` origin alır, öneki kod ekler). `/health` önek dışında.
- **Giriş:** `GET /auth/sep10?account=` → imza → `POST /auth/sep10` → `{token, expires_at, public_key, registered, user}`.
  Süre dolunca `POST /auth/refresh` (cüzdanda yeni imza gerekmez). Mesaj imzalayan cüzdanlar için `POST /auth/nonce` + `/auth/verify` de var.
- **Sözleşme kuralları:** tutarlar string, oranlar bps (2000 = %20), piyasalar `crypto | stable_fx | defi`,
  risk iki ölçekli (`risk_profile` ilanlarda, `risk_level` trader profilinde).
- **Zincir üstü:** backend XDR üretir (`POST /agreements/{id}/tx/{action}`) → cüzdan imzalar → `POST /tx/submit`.
- Ayrıntı ve ekran → uç eşlemesi: [docs/api-entegrasyon.md](docs/api-entegrasyon.md).

## Kurulum durumu (hazır)

- [x] Expo SDK 57 + TypeScript + expo-router (typed routes), Inter fontları, ESLint/Prettier
- [x] Tema token'ları Figma DS ile birebir (`src/theme`) — bkz. `docs/design-system.md`
- [x] UI kütüphanesi: Button, Chip, Pill, RiskBadge, StatusChip, KpiBox/Stat, Avatar, Segmented, Field, ListRow, Card, **Sparkline, BottomSheet, Switch, Progress**; layout: Screen, TopBar/ScreenHeader, TabBar (rol bazlı), RiskStrip, Placeholder
- [x] Navigasyon iskeleti: `(auth)` → rol bazlı `(customer)` / `(trader)` tab grupları + paylaşılan stack ekranları; `app/index.tsx` oturuma göre yönlendirir
- [x] Cüzdan adaptörü: web = Stellar Wallets Kit v2, **native = uygulama içi cüzdan (varsayılan) + SEP-7 harici cüzdan + isteğe bağlı WalletConnect**, seçim ekranıyla
- [x] **Expo Go uyumu:** özel native modül yok; rastgelelik `expo-crypto` ile (eski `react-native-get-random-values` kaldırıldı), pano `expo-clipboard`, QR `react-native-qrcode-svg` (react-native-svg üzerinden)
- [x] `@stellar/stellar-sdk` 17 (RPC/Horizon istemcileri, polyfill'ler), SEP-10 giriş akışı (`lib/auth/`), oturum store'u (zustand + SecureStore/localStorage)
- [x] API istemcisi + tüm endpoint'ler tiplenmiş (`lib/api/endpoints.ts`), gerçek backend'e bağlı `.env`
- [x] `npm run typecheck`, `npm run lint`, `npx prettier --check`, `npm run export:web` temiz geçiyor
- [x] iOS ve Android paketleri Metro'da hatasız derleniyor (`/node_modules/expo-router/entry.bundle?platform=ios|android`)

## Definition of Done (her ekran görevi için)

1. Figma frame'iyle piksel değil ama **yapı ve metin** olarak birebir (Türkçe metinler Figma'dan kopyalanır).
2. Veri `src/lib/api` üzerinden gelir; bileşen içinde sabit veri yok. Endpoint hazır değilse `Placeholder` yerine **boş/yükleniyor/hata durumu** gösterilir.
3. Web'de (Chrome, 390px genişlik) ve mümkünse Expo Go'da (cüzdansız ekranlar) kontrol edilmiş.
4. `npm run check` temiz; PR'da Figma node linki var.
5. Her ekranda Risk Strip görünür.

## Görevler

Öncelik = gelistirme-notlari §4.5 sırası. Tahmin: S ≤ ½ gün · M ≈ 1 gün · L ≈ 2 gün.
**Durum:** ✅ bitti · 🟡 istemci tarafı bitti, backend ucu bekleniyor · ⬜ başlanmadı.

| ID | Görev | Figma | Tahmin | Bağımlılık | Sahip | Durum |
|---|---|---|---|---|---|---|
| FE-01 | ~~Proje kurulumu, tema, UI kit, navigasyon iskeleti~~ | DS 0:1 | L | — | Claude | ✅ |
| FE-02 | ~~Onboarding + Giriş (cüzdan) + Rol Seçimi~~ | 19:13 · 19:109 · 19:181 | M | — | Claude | ✅ |
| FE-03 | Kayıt · Bilgiler formu (Müşteri / Trader varyantı) → `POST /users/register` | 19:269 · 19:353 | M | — | Claude | 🟡 |
| FE-04 | SEP-10 girişi (`/auth/sep10`), `/auth/refresh` ile 401 yenileme, hata mesajları | 19:109 | S | — | Claude | 🟡 |
| FE-05 | Keşfet · Müşteri deck → `GET /discover` + `POST /discover/.../action` | 21:30 · 21:282 | L | — | Claude | 🟡 |
| FE-06 | Keşfet · Trader + "Teklif Ver" sheet → `POST /offers` | 21:160 · 21:414 | M | — | Claude | 🟡 |
| FE-07 | ~~Bottom Sheet + Switch + Progress ortak bileşenleri~~ | 23:181 · 30:536 | S | — | Claude | ✅ |
| FE-08 | Mesajlar listesi + Sohbet ekranı | 28:171 · 28:266 | M | BE-04 | | ⬜ |
| FE-09 | Sözleşme ekranı + "Onaylamak için kaydır" → escrow kontrat çağrısı (bindings, simulate, imza, `POST /tx/submit`), işlem durumu UI'ı | 28:320 | L | BE-05, BE-06 | | ⬜ |
| FE-10 | Panel · Müşteri (portföy KPI + sparkline, takip listesi, ilan etkileşimleri) | 30:97 | M | BE-03, BE-07 | | ⬜ |
| FE-11 | Panel · Trader (profil tamamlama, bekleyen teklifler, aktif yatırımcılar) | 23:362 | M | BE-03, BE-07 | | ⬜ |
| FE-12 | Hareketler · birleşik akış + trader bazlı görünüm + "Görünümü Düzenle" sheet | 30:252 · 30:375 · 30:536 | M | BE-08 | | ⬜ |
| FE-13 | Mobil cüzdan: uygulama içi cüzdan (cihazda anahtar) + SEP-7 harici cüzdan; WalletConnect isteğe bağlı | — | M | BE-02 (SEP-7 uçları) | Claude | 🟡 |
| FE-14 | İşlemler · Trader (K/Z başlığı, açık/geçmiş) + "Yeni İşlem" sheet → `tradesApi.create` | 23:45 · 23:181 | M | BE-08 | | ⬜ |
| FE-15 | İlanlarım (iki rol) + İlan Detayı (teklifler/talepler/ilgi sekmeleri) | 26:58 · 26:203 · 26:345 · 26:462 | M | BE-03 | | ⬜ |
| FE-16 | İlan Oluştur sihirbazı (4 adım; risk profili adımı Figma'da) → `listingsApi.create` + zincir üstü ilan kaydı | 28:106 | M | BE-05 | | ⬜ |
| FE-17 | Trader Profili (KPI grid, performans segmented + sparkline, canlı hareketler, strateji, yorumlar) | 22:171 | M | BE-03, BE-08 | | ⬜ |
| FE-18 | Profil (iki rol) + Cüzdan (Horizon bakiye, TRY Yatır/Çek → SEP-24 interactive URL `expo-web-browser`, durum sorgusu, son işlemler) | 27:436 · 27:569 · 27:699 | L | BE-09 | | ⬜ |
| FE-19 | Bildirimler (liste, gruplar, tümünü oku, boş durum) | 27:96 · 27:240 · 27:371 | S | BE-10 | | ⬜ |
| FE-20 | ~~Sparkline bileşeni (react-native-svg) — Panel, Keşfet kartı, Trader Profili~~ | — | S | — | Claude | ✅ |
| FE-21 | Web deploy (Vercel / Netlify / EAS Hosting — karar §8.15) + `.env` production değerleri + herkese açık URL | — | S | BE-05 | | ⬜ |
| FE-22 | README: kurulum, test adımları, ekran görüntüleri, Stellar entegrasyon listesi; Mermaid diyagramı güncel | — | S | — | | ⬜ |
| FE-23 | Uçtan uca demo provası: giriş → ilan → yatırma → sözleşme → ödeme → çekim (Testnet, gerçek veri) | — | M | tüm BE-* | | ⬜ |

Backend beklemeden ilerletilebilecek işler: **FE-12 / FE-14** (FE-07 bileşenleri hazır), **FE-13**, ve FE-15–FE-19'un UI katmanı.

## Yapılanların özeti (commit sırası)

| Commit | Kapsam |
|---|---|
| `chore: Sprint 1 iskeleti` | FE-01, FE-02 — monorepo, tema, UI kit, navigasyon, cüzdan adaptörü, API katmanı |
| `FE-03` | Kayıt formu (iki rol), alan doğrulama, `session.register()`; `CustomerRegisterPayload` / `TraderRegisterPayload` BE-01'e öneri |
| `FE-04` | `assertValidChallenge` (sequence 0, zaman aralığı, istemci `manageData`, passphrase), `lib/auth/jwt.ts` (`exp` + 30 sn pay), 401 köprüsüyle tek seferlik SEP-10 yenileme, `lib/errors.ts` tek hata metni kaynağı |
| `FE-05 + FE-20` | `SwipeDeck`, `ServiceListingCard`, `Sparkline`; Keşfet · Müşteri `GET /listings?kind=service`'e bağlı |
| `FE-06 + FE-07` | `BottomSheet`, `Switch`, `Progress`; `CapitalListingCard`, `OfferSheet`; Keşfet · Trader `GET /listings?kind=capital` + `POST /listings/:id/offers`; API `/api/v1` önekine taşındı, Giriş'e sunucu durumu göstergesi |

**FE-13 notu (🟡):** Mobil cüzdan artık **üçüncü taraf servise bağlı değil**. Üç yol var, ilki varsayılan:

- **Uygulama içi cüzdan:** anahtar çifti cihazda üretilir, `expo-secure-store` (iOS Keychain / Android Keystore) içinde kalır, imza cihazda atılır; gizli anahtar hiçbir yere gönderilmez. İçe aktarma (S…) ve yedekleme de var. Doğrulandı: `WebAuth.buildChallengeTx` ile üretilen SEP-10 challenge bu yolla imzalanınca `WebAuth.verifyChallengeTxSigners`'dan geçiyor, yanlış anahtar reddediliyor.
- **SEP-7 (Lobstr, xBull):** `web+stellar:tx?xdr=…&callback=url:<api>/auth/sep7-callback` linki cüzdanı açar; imzalı XDR **doğrudan kendi backend'imize** POST edilir, uygulama `GET /auth/sep7-status/{id}` ile bekler. Sözleşme: [docs/backend-sozlesme.md](docs/backend-sozlesme.md).
- **WalletConnect:** kod duruyor ama isteğe bağlı — `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` tanımlıysa seçim ekranında görünür, yoksa hiç çıkmaz. Böylece reown relay'ine bağımlılık zorunlu olmaktan çıktı.
- **Freighter:** web'de giriş ekranında doğrudan **Connect Freighter** düğmesi var (Wallets Kit modülü, modal açılmadan). Mobilde Freighter **yalnızca WalletConnect** ile bağlanıyor (kaynak: `docs.freighter.app/mobile-walletconnect`), yani telefonda Freighter isteniyorsa proje kimliği zorunlu.

**Açık kalanlar**

- 🟡 görevlerin uçtan uca doğrulaması ilgili BE-* ucu açılınca yapılacak; şu an ekranlar 404'ü hata durumu olarak gösteriyor (sahte veri yok).
- **DoD-3 (Chrome 390px elle kontrol) hiçbir ekran için yapılmadı** — `cd app && npm run web`.
- **Mobil cüzdan gerçek cihazda denenmedi.** Test yolu Expo Go: [docs/mobil-test.md](docs/mobil-test.md). Bu makinede Xcode/Android SDK yok, simülatör açılamıyor; karar: Expo Go ile telefonda ilerlemek.
- **SEP-7 yolu BE-02'ye bağlı**: `/auth/challenge` yanıtına `id` eklenmeli, `/auth/sep7-callback` ve `/auth/sep7-status/{id}` açılmalı. Uygulama içi cüzdan yolu yalnızca `/auth/challenge` + `/auth/verify` ister.
- Keşfet aksiyonları için önerilen uçlar: `POST /listings/:id/requests` (müşteri teklif ister), `POST /listings/:id/offers` (trader teklif verir), `POST /listings/:id/saves` (trader kaydeder). Backend farklı isimlendirirse `endpoints.ts` güncellenir.
- `Listing.owner` özeti (ad, baş harf, rating, 12 ay getiri, drawdown, sparkline, etiketler) `/listings` yanıtında gömülü bekleniyor; gelmezse kartta yalnızca cüzdan adresi görünür.

## Backend durumu

Tüm uçlar canlı (92). Frontend'in kullandığı gruplar:

| Alan | Uçlar | Frontend'de bağlı mı |
|---|---|---|
| Kimlik | `/auth/sep10`, `/auth/refresh`, `/auth/me` | ✅ |
| Kullanıcı | `/users/register`, `/users/me` | ✅ |
| Keşfet | `/discover`, `/discover/.../action` | ✅ |
| Teklifler | `/offers*` | ✅ (oluşturma) |
| Trader | `/traders*` | ✅ (takip) |
| Panel · Hareketler | `/dashboard`, `/activity` | ⬜ FE-10/11/12 |
| İlanlar | `/listings*` | ⬜ FE-15/16 |
| Sözleşme | `/agreements*`, `/tx/submit` | ⬜ FE-09 |
| Mesajlar | `/conversations*` | ⬜ FE-08 |
| Bildirim | `/notifications*` | ⬜ FE-19 |
| Cüzdan · Anchor | `/wallet*`, `/anchor*` | ⬜ FE-18 |

## Riskler ve kararlar

- **Mobil cüzdan (FE-13):** WalletConnect v2 relay'i self-host edilemez — v2 relay açık kaynak değil ve cüzdanlar kendi varsayılan relay'lerine bağlanır. Bağımsızlık için **uygulama içi cüzdan + SEP-7** seçildi. Gerçek cihaz testi yapılmadan "çalışıyor" denemez; SEP-7 desteği cüzdandan cüzdana değişebilir.
- **Uygulama içi cüzdan güven modeli:** anahtar cihazda durur, hackathon Testnet demosu için uygundur. Mainnet'e geçilirse kullanıcıya harici cüzdan (SEP-7 / Freighter) önerilmeli; bu ayrım README ve Profil ekranında açıkça yazılmalı.
- **Expo Go kısıtı:** Expo Go yalnızca kendi içine gömülü native modülleri çalıştırır. Yeni bir native bağımlılık eklenirse (ör. `react-native-quick-crypto`) Expo Go kırılır ve development build gerekir. Şu an tüm bağımlılıklar Expo Go uyumlu.
- **Stellar Wallets Kit npm paketi** (`@creit.tech/stellar-wallets-kit` 2.6) kullanılıyor; bakımcılar npm güncellemelerini durdurabilir → gerekirse `npx jsr add @creit-tech/stellar-wallets-kit`'e geçiş (import yolları aynı).
- **SEP-10'da yenileme token'ı yok:** süresi dolan JWT için challenge yeniden imzalatılır, yani yenileme cüzdanda imza isteği açar. Sunucu `expiresAt` vermezse JWT `exp` claim'i kullanılır.
- **TRY anchor Testnet'te yok** ise Testnet anchor ile aynı SEP-24 akışı TRY etiketiyle sunulur (§3.3). Mentörlere sorulacak.
- **Rol modeli:** bir cüzdan tek rol mü? (§8.6) Şu an `index.tsx` tek rol varsayar; iki rol olursa rol değiştirici Profil'e eklenir.
- **Sahte veri yasağı:** geliştirme sırasında geçici veri yalnızca `lib/api` altında, `__DEV__` koşuluyla ve `TODO(remove-before-submit)` etiketiyle tutulur.
- **Reanimated + React Compiler lint:** shared value yazımları (`x.value = …`) `react-hooks/immutability` kuralını tetikliyor; `SwipeDeck` dosya başında gerekçesiyle devre dışı bırakıldı (reanimated 4.5 `get`/`set` yardımcılarını dışa açmıyor).

## Ritüeller

- Günlük 10 dk senkron: bloklayan BE-* maddeleri.
- Her ekran ayrı PR; PR başlığında görev ID'si (`FE-05 Keşfet deck`).
- Sprint sonu: FE-23 demo provası kayıt altına alınır (ekran kaydı → README).
