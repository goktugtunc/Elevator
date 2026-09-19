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
- **Kayıt yanıtı `RegisterOut`'tur, `MeOut` değil.** Gövde `{ user, token, expires_at }`
  taşır ve buradaki token rolü içerir; eski token rolsüzdür. İstemci yeni token'ı
  saklamazsa `/auth/me` de rol döndürmez ve kullanıcı rol seçimine geri düşer
  (bu hata bir kez yaşandı, bkz. `store/session.ts → register`).
- JWT süresi dolduğunda **cüzdanda yeni imza gerekmez**: `POST /auth/refresh`.
  401 köprüsü (`registerAuthBridge`) önce bunu dener, başarısızsa oturumu kapatır.
- Mesaj imzalayan cüzdanlar için alternatif: `POST /auth/nonce` → `POST /auth/verify`
  (`login_message_prefix` `/config`'ten gelir). Şu an kullanılmıyor.

## Ekran → uç eşlemesi

| Ekran | Uçlar |
|---|---|
| Giriş | `GET /config`, `GET/POST /auth/sep10`, `GET /auth/me`, `POST /auth/refresh` |
| Kayıt | `POST /users/register` → **`RegisterOut`**: profil **ve rolü taşıyan yeni token** |
| Keşfet (iki rol) | `GET /discover`, `POST /discover/{target_type}/{target_id}/action` |
| Teklif Ver | `POST /offers`; kabul/ret `POST /offers/{id}/accept|reject|withdraw` |
| Panel (iki rol) | `GET /dashboard` — rol'e göre `TraderDashboardOut` ya da `CustomerDashboardOut` |
| Hareketler | `GET /activity` (`trader_id`, `state=open|closed`) |
| İlanlarım | `GET /listings/mine`, `/listings/mine/counts`; `POST /listings/{id}/pause|resume|close` |
| İlan Detayı | `GET /listings/{id}` (`ListingDetailOut`), `GET /offers?listing_id=` |
| İlan Oluştur | `POST /listings` (`ListingCreateIn`), `GET /assets?base_only=true` |
| Sözleşme | `GET /agreements/{id}`, `/value-history`, `/trades`; `POST /agreements/{id}/tx/{action}` → imza → `POST /tx/submit` |
| Yeni İşlem | `GET /agreements/{id}/quote` (imzadan önce drawdown kontrolü) → `POST /agreements/{id}/tx/trade` |
| Trader Profili | `GET /traders/{id}/profile` (`range`, `trades`), `POST|DELETE /traders/{id}/follow` |
| Mesajlar | `GET /conversations`, `/conversations/{id}/messages`, `POST .../messages`, `POST .../read` |
| Bildirimler | `GET /notifications`, `/unread-count`, `POST /notifications/read`, `PUT /notifications/push-token` |
| Profil | `GET /users/me`, `PATCH /users/me` |
| Cüzdan | `GET /wallet?movements=true`, `/wallet/deposit-info`, `POST /wallet/tx/payment|trustline` |
| Anchor | `GET /anchor/info`, `POST /anchor/deposit|withdraw`, `GET /anchor/transactions`, `POST /anchor/transactions/{ref}/tx/payment` |

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


## Tipler nereden geliyor

`src/lib/api/schema.ts` **elle yazılmaz**, sunucunun OpenAPI şemasından üretilir:

```bash
cd app && npm run gen:api     # /openapi.json indirir, 98 tipi üretir
npm run typecheck             # sözleşme değiştiyse burada patlar
```

`types.ts` yalnızca bu dosyayı yeniden dışa aktarır; `endpoints.ts` ise yol ve
sorgu parametrelerini bağlar. Sunucu şeması değişince derleyici uyumsuz çağrı
yerlerini tek tek gösterir — elle yazılan tiplerde bu emniyet yoktu ve
`markets` / `*_bps` alanlarının aslında opsiyonel olduğu ancak üretime geçince
görüldü.

**Sayfalama offset tabanlıdır** (`limit` / `offset`, yanıt `Page<T>` =
`{ items, total, limit, offset }`). Tek istisna `GET /discover`: o uç cursor
kullanır.

## Zincir üstü akışın tek motoru

Bütün imza gerektiren işler `src/lib/onchain.ts` içindeki `useOnchainAction`
üzerinden geçer:

```
sunucu XDR üretir (UnsignedTxOut)
  → wallet.signTransaction(unsigned_xdr, { networkPassphrase, address: source })
  → POST /tx/submit { xdr, pending_id } → TxSubmitOut
```

Hangi adımın mümkün olduğunu **sunucu** söyler (`agreement.available_actions`);
arayüz kendi başına varsaymaz. Kullanılan yerler: sözleşme adımları
(`open` / `propose` / `fund` / `accept` / `settle` / `cancel`), yeni işlem
(`/tx/trade`), cüzdan trustline'ı ve anchor çekim ödemesi.
