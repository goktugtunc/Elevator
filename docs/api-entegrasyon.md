# API entegrasyonu — TraderKirala API

**Sunucu:** <https://mobilback.yolalapp.com> · **Şema:** `/docs`, `/openapi.json` (92 uç)
**Base URL:** `https://mobilback.yolalapp.com/api/v1` (`.env → EXPO_PUBLIC_API_BASE_URL` origin alır, öneki kod ekler)

Backend ayrı bir depoda geliştiriliyor; bu repoda `backend/` klasörü yok.
Sözleşme tek kaynaktan gelir: sunucunun OpenAPI şeması. Frontend karşılıkları
`app/src/lib/api/types.ts` (şema tipleri) ve `app/src/lib/api/endpoints.ts`.

## Sözleşmedeki önemli kurallar

- **Tutarlar string** (`"1000.50"`) — ondalık kaybı olmasın diye. `formatAmount` ile gösterilir.
- **Oranlar bps** — 2000 = %20. Kullanıcı yüzde girer, `× 100` ile bps'e çevrilir (`formatBps` tersini yapar).
- **Piyasalar üç kategori:** `crypto` · `stable_fx` · `defi` (en fazla 3 seçim).
- **Risk iki ölçek:** ilanlarda `risk_profile` (conservative/balanced/aggressive), trader profilinde `risk_level` (low/medium/high). `RiskBadge` ikisini de kabul eder.
- **Hata gövdesi:** `{code, message, details}` → `ApiError.code` / `.message`.
- **Rate limit:** `/api/v1/auth/` için 10 istek/sn, diğer yollar 60 istek/sn.

## Giriş akışı (SEP-10)

```
GET  /api/v1/auth/sep10?account=G…   → { transaction, network_passphrase }
     istemci challenge'ı doğrular (sequence 0, timebounds, manageData source)
     cüzdan imzalar (WalletConnect → Freighter / Lobstr / xBull)
POST /api/v1/auth/sep10  { transaction } → { token, expires_at, public_key, registered, user }
```

- `registered: false` → kullanıcı `POST /users/register` akışına düşer.
- JWT süresi dolduğunda **cüzdanda yeni imza gerekmez**: `POST /auth/refresh`.
  401 köprüsü (`registerAuthBridge`) önce bunu dener, başarısızsa oturumu kapatır.
- Mesaj imzalayan cüzdanlar için alternatif: `POST /auth/nonce` → `POST /auth/verify`
  (`login_message_prefix` `/config`'ten gelir). Şu an kullanılmıyor.

## Ekran → uç eşlemesi

| Ekran | Uçlar |
|---|---|
| Giriş | `GET /config`, `GET/POST /auth/sep10`, `GET /auth/me`, `POST /auth/refresh` |
| Kayıt | `POST /users/register` (RegisterIn: customer / trader blokları) |
| Keşfet (iki rol) | `GET /discover`, `POST /discover/{target_type}/{target_id}/action` (`pass`/`like`/`save`/`follow`/`offer_request`) |
| Teklif Ver | `POST /offers` (OfferCreateIn: amount, duration_days, commission_bps…) |
| Takip | `POST/DELETE /traders/{id}/follow` |
| Panel | `GET /dashboard` |
| Hareketler | `GET /activity` |
| İlanlarım | `GET /listings/mine`, `/listings/mine/counts`, `/listings/saved` |
| Sözleşme | `GET /agreements/{id}`, `POST /agreements/{id}/tx/{action}` → imza → `POST /tx/submit` |
| Mesajlar | `GET /conversations`, `/conversations/{id}/messages` |
| Bildirimler | `GET /notifications`, `POST /notifications/read`, `PUT /notifications/push-token` |
| Cüzdan | `GET /wallet`, `POST /wallet/tx/payment`, `/wallet/tx/trustline` |
| Anchor | `GET /anchor/info`, `POST /anchor/deposit|withdraw`, `GET /anchor/transactions` |

## Zincir üstü işlemler

Backend XDR üretir, **kullanıcı cüzdanda imzalar**, imzalı XDR geri gönderilir:

```
POST /api/v1/agreements/{id}/tx/{action}   → { xdr, pending_id }
wallet.signTransaction(xdr)                 → imzalı XDR
POST /api/v1/tx/submit { xdr, pending_id }  → { status, hash }
GET  /api/v1/tx/{pending_id}                → durum takibi
```

Gizli anahtar hiçbir adımda sunucuya gitmez. Vault kontrat kimliği ve ağ
ayarları `GET /config` içinde (`vault_contract_id`, `soroban_rpc_url`, `network_passphrase`).
