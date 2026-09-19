# backend/ — API, SEP-10, indeksleyici, anchor proxy (placeholder)

Bu sprintte yalnızca `app/` geliştirilir. Backend teknolojisi henüz kararlaştırılmadı (gelistirme-notlari §8.9).

Frontend'in tükettiği sözleşme `app/src/lib/api/endpoints.ts` dosyasında tiplenmiştir; OpenAPI şeması yayınlandığında o dosya şemaya hizalanır.

| Endpoint | Amaç |
|---|---|
| `POST /auth/challenge`, `POST /auth/verify` | SEP-10 → JWT |
| `GET /profile`, `POST /register` | rol + profil |
| `GET /listings`, `GET /listings/:id`, `GET /my/listings` | ilanlar (indeksleyici) |
| `POST /follow`, `GET /follows` | takip (zincir dışı) |
| `GET /contracts`, `GET /contracts/:id` | escrow yansıması |
| `GET /transactions` | işlemler / hareketler |
| `POST /anchor/deposit`, `POST /anchor/withdraw`, `GET /anchor/status/:id` | SEP-24 interactive URL |
| `POST /tx/submit` | imzalı XDR → OpenZeppelin Relayer |
| `GET /messages`, `POST /messages`, `GET /notifications` | mesaj / bildirim |

Anchor anahtarları yalnızca sunucuda kalır; kullanıcı anahtarı backend'e asla gelmez.
