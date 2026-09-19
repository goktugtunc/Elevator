# TraderKirala

Freelance trader'ları sermaye sahipleriyle buluşturan, sözleşme ve escrow'u Stellar (Soroban) üzerinde tutan mobil-öncelikli uygulama. **Risein Stellar Pro Hackathon** projesi.

> Yatırım ve komisyon getirileri piyasa koşullarına bağlıdır, sermaye kaybı riski içerir.

## Repo yapısı (monorepo)

```
traderkirala/
├── app/          Expo + React Native (birincil hedef Expo Web) — bu sprintte geliştirilen tek paket
├── contracts/    Soroban kontratları (Rust) — placeholder
├── backend/      SEP-10 auth, indeksleyici, anchor proxy, Relayer — placeholder
├── docs/         Tasarım sistemi notları, geliştirme notları
└── SPRINT-1.md   Sprint planı ve görev listesi
```

## Servisler

| Ne | Nerede |
|---|---|
| Backend API | <https://mobilback.yolalapp.com> · uçlar `/api/v1` önekiyle · şema: `/docs`, `/openapi.json` |
| Ağ | Stellar **Testnet** (`Test SDF Network ; September 2015`) |
| Frontend | Yerel: `http://localhost:8081` · herkese açık URL: FE-21 ile eklenecek |

## Hızlı başlangıç (frontend)

```bash
cd app
cp .env.example .env      # backend URL'si hazır; kontrat ID'leri deploy sonrası
npm install
npm run web               # http://localhost:8081
```

Diğer komutlar: `npm run typecheck`, `npm run lint`, `npm run export:web` (statik build → `app/dist`).

Cüzdan: web'de Stellar Wallets Kit (Freighter, xBull, Albedo, Lobstr…). Freighter'ı **Testnet**'e alın. Mobil cüzdan (WalletConnect) sprint kapsamında prototiplenecek.

## Mimari

```mermaid
flowchart LR
  subgraph Client["app/ · Expo (Web + iOS/Android)"]
    UI[Ekranlar · expo-router]
    Store[Oturum · zustand]
    Wallet[Cüzdan adaptörü<br/>Stellar Wallets Kit / WalletConnect]
    SDK[@stellar/stellar-sdk<br/>contract.Client + bindings]
  end

  subgraph Backend["backend/"]
    Auth[SEP-10 Auth → JWT]
    API[REST API<br/>/listings /contracts /transactions …]
    Indexer[İndeksleyici<br/>RPC events + Horizon → DB]
    AnchorProxy[Anchor proxy<br/>SEP-1 / SEP-24 / SEP-12]
    Relayer[OpenZeppelin Relayer<br/>ücret sponsorluğu · /tx/submit]
  end

  subgraph Chain["Stellar Testnet"]
    RPC[(Soroban RPC)]
    Horizon[(Horizon)]
    Listing[[Listing kontratı]]
    Escrow[[Escrow / Sözleşme kontratı]]
  end

  Anchor[(TRY Anchor)]

  UI --> Store
  UI --> Wallet
  UI --> SDK
  UI -->|JWT| API
  Wallet -->|challenge imzası| Auth
  SDK -->|simulate / read| RPC
  SDK -->|imzalı XDR| Relayer
  Relayer --> RPC
  RPC --- Listing
  RPC --- Escrow
  Indexer --> RPC
  Indexer --> Horizon
  API --> Indexer
  AnchorProxy --> Anchor
  UI -->|interactive URL| Anchor
```

**Çekirdek akış (uçtan uca):** giriş (SEP-10) ve rol → ilan → TRY yatırma (SEP-24) → sözleşme ve escrow (Soroban) → ödeme → çekim.

## Stellar entegrasyonları

| Alan | Kullanım |
|---|---|
| Kimlik | SEP-10 challenge/imza/JWT (backend), cüzdan imzası istemcide |
| Cüzdan | Stellar Wallets Kit v2 (web), Freighter mobile + WalletConnect v2 (mobil, prototip) |
| Kontrat çağrısı | `@stellar/stellar-sdk` `contract.Client` + CLI ile üretilen typed bindings |
| Ücret sponsorluğu | OpenZeppelin Relayer — imzalı XDR `POST /tx/submit` ile backend'e gider |
| Anchor | SEP-1 keşif, SEP-24 yatırma/çekme (interactive URL), gerekirse SEP-12 KYC |
| Veri | Stellar RPC event'leri (tercih) + Horizon; indeksleyici DB'ye yazar |
| Doğrulama | Stellar Lab, stellar.expert (testnet) |

## Belgeler

- [SPRINT-1.md](SPRINT-1.md) — sprint planı ve görev listesi
- [docs/design-system.md](docs/design-system.md) — Figma tasarım sistemi ↔ kod eşlemesi
- [docs/gelistirme-notlari.md](docs/gelistirme-notlari.md) — teknik kararlar, birleşme noktaları, açık konular
- Figma: `6ZxzvsYKarDglg0PGYRIgP` — TraderKirala Mobil Tasarım Sistemi

## Kontrat ID'leri ve deploy çıktıları

_İlk Testnet deploy sonrası backend ekibi burayı doldurur (kontrat ID, deploy tx hash, stellar.expert linki)._

| Kontrat | ID | Deploy tx |
|---|---|---|
| Listing | — | — |
| Escrow | — | — |
