# Backend sözleşmesi — kimlik doğrulama (BE-01, BE-02)

Sunucu: <https://mobilback.yolalapp.com> · önek `/api/v1` · ağ **Testnet**
(`Test SDF Network ; September 2015`) · home domain `mobilback.yolalapp.com`.

Frontend'de karşılıkları: `app/src/lib/api/endpoints.ts`, `app/src/lib/auth/`.
Uygulama **üçüncü taraf cüzdan servisi kullanmıyor**; iki imza yolu var ve
ikisi de yalnızca bu uçlarla konuşuyor:

| Yol | İmza nerede atılır | Kullandığı uçlar |
|---|---|---|
| Uygulama içi cüzdan (varsayılan) | Cihazda, `expo-secure-store`'daki anahtarla | `/auth/challenge` → `/auth/verify` |
| SEP-7 (Lobstr, xBull) | Harici cüzdan uygulamasında | `/auth/challenge` → **cüzdan** `/auth/sep7-callback` → `/auth/sep7-status/{id}` |
| Web (Freighter / Wallets Kit) | Tarayıcı uzantısında | `/auth/challenge` → `/auth/verify` |

---

## 1. `POST /api/v1/auth/challenge`

SEP-10 challenge üretir.

**İstek**
```json
{ "account": "GABC…" }
```

**Yanıt**
```json
{
  "transaction": "<base64 XDR>",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "id": "5f1c…"
}
```

- `id` **SEP-7 için zorunlu**: cüzdan callback'e imzayı gönderdiğinde hangi
  challenge olduğunu bu kimlikle eşleştiriyoruz. Sunucu `id → {account, challenge_xdr,
  created_at, status}` kaydını kısa ömürlü (≈5 dk) tutmalı.
- Challenge SEP-0010'a uygun olmalı: `sequence = 0`, zaman aralığı ≤ 5 dk,
  ilk işlem `manageData` ve **source = istemci hesabı**, adı `mobilback.yolalapp.com auth`,
  değeri 64 baytlık base64 nonce; ikinci `manageData` `web_auth_domain`.
- İstemci bu alanları imzalamadan **kendisi de doğruluyor**
  (`app/src/lib/auth/sep10.ts → assertValidChallenge`), uyuşmazsa imza istemiyor.

Python (mevcut yığına uygun):
```python
from stellar_sdk.sep.stellar_web_authentication import build_challenge_transaction

xdr = build_challenge_transaction(
    server_secret=SERVER_SECRET,
    client_account_id=account,
    home_domain="mobilback.yolalapp.com",
    web_auth_domain="mobilback.yolalapp.com",
    network_passphrase=NETWORK_PASSPHRASE,
    timeout=300,
)
```

## 2. `POST /api/v1/auth/verify`

Cihazda imzalanan challenge'ı doğrular ve oturum açar.

**İstek**
```json
{ "transaction": "<imzalı base64 XDR>" }
```

**Yanıt**
```json
{ "token": "<JWT>", "expiresAt": "2026-09-19T21:30:00Z" }
```

- `expiresAt` verilmezse istemci JWT'nin `exp` claim'ini okur; ikisi de yoksa
  süre bilinmez ve yalnızca 401'e göre davranılır.
- JWT'nin `sub` alanı cüzdan adresi olmalı; korumalı uçlar `Authorization: Bearer`
  ile çalışır.
- Doğrulama: `read_challenge_transaction` + `verify_challenge_transaction_signers`.
  İmza geçersizse `401`, challenge süresi dolmuşsa `400` döndürün.

## 3. `POST /api/v1/auth/sep7-callback`  ← **cüzdan çağırır**

SEP-0007 `tx` işleminde `callback=url:https://mobilback.yolalapp.com/api/v1/auth/sep7-callback`
gönderiyoruz. Cüzdan, kullanıcı onayladıktan sonra imzalı XDR'ı **bu uca POST eder**:

- `Content-Type: application/x-www-form-urlencoded`
- Gövde: `xdr=<imzalı base64 XDR>` (bazı cüzdanlar JSON gönderebilir — ikisini de kabul edin)
- Bu istekte JWT yoktur; uç **kimlik doğrulamasız** olmalı.

Sunucunun yapacağı:
1. XDR'ı çöz, içindeki `manageData` nonce'undan / istemci hesabından bekleyen
   challenge kaydını bul (`id`'yi nonce ya da hesap üzerinden eşleştirin).
2. İmzayı SEP-10 kurallarıyla doğrula.
3. Kaydı `completed` yap ve JWT'yi kayda yaz.
4. Cüzdana `200` ve kısa bir JSON döndür: `{"status":"ok","message":"You can return to TraderKirala"}`.
   Hata durumunda kaydı `failed` yapıp `400` dönün.

> Uygulama bu uca hiç istek atmaz; yalnızca cüzdan atar. Bu yüzden CORS değil,
> **açık erişim** ve oran sınırlama önemlidir.

## 4. `GET /api/v1/auth/sep7-status/{id}`

Uygulama, cüzdan imzalayana kadar bu ucu 2 saniyede bir yoklar (en fazla 3 dakika).

**Yanıt**
```json
{ "status": "pending" }
{ "status": "completed", "token": "<JWT>", "expiresAt": "2026-09-19T21:30:00Z" }
{ "status": "failed", "message": "Signature did not match the requested account" }
```

- `completed` yanıtı **bir kez** verilmeli; token teslim edildikten sonra kayıt silinebilir.
- Kimlik doğrulaması istemez (id zaten tek kullanımlık ve tahmin edilemez olmalı: ≥128 bit rastgele).

## 5. `POST /api/v1/register` (BE-01)

JWT ile çağrılır. Gövde role göre ayrışır:

```jsonc
// role = "customer"
{ "role": "customer", "username": "elifyilmaz", "budgetTRY": 250000,
  "riskPreference": "low|mid|high",
  "markets": ["BIST Equities", "Crypto", "Forex", "Futures", "Commodities"] }

// role = "trader"
{ "role": "trader", "username": "kaandemir",
  "markets": ["Crypto"], "strategySummary": "…",
  "commissionPct": 20, "minCapitalTRY": 50000 }
```

**Yanıt** `UserProfile`:
```json
{ "address": "GABC…", "role": "trader", "username": "kaandemir",
  "avatarInitials": "KD", "createdAt": "2026-09-19T18:00:00Z" }
```

Cüzdan adresi gövdede gönderilmez; JWT'den okunur. Kullanıcı adı çakışırsa `409`.

## Hata gövdesi

Mevcut biçim korunmalı — istemci `message` alanını kullanıcıya gösterir,
`code` alanını `ApiError.code`'a taşır:

```json
{ "code": "validation_error", "message": "Username is already taken", "details": {} }
```

## Test ipuçları

```bash
# challenge
curl -s -X POST https://mobilback.yolalapp.com/api/v1/auth/challenge \
  -H 'content-type: application/json' -d '{"account":"G…"}'

# sep7 durumu
curl -s https://mobilback.yolalapp.com/api/v1/auth/sep7-status/<id>
```

Frontend tarafında ilgili kod: `lib/auth/sep10.ts` (challenge doğrulama),
`lib/auth/sep7.ts` (URI + yoklama), `lib/wallet/local.ts` (cihazda imza).
