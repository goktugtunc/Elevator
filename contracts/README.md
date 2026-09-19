# contracts/ — Soroban kontratları (placeholder)

Bu sprintte yalnızca `app/` geliştirilir. Backend ekibi kontratları buraya ekler.

Frontend'in beklediği (gelistirme-notlari §2, §3.1):

- **Listing kontratı:** ilan oluşturma / güncelleme / listeleme / kapatma. Event: `listing_opened`.
- **Escrow kontratı:** teklif → kabul → kilitleme → sonuçlanma / iade → ödeme. Event'ler: `contract_accepted`, `payment_made`.
- `require_auth` ve doğru storage türleri (persistent / instance / temporary).
- İlk deploy'da `stellar contract bindings typescript` çıktısı `app/src/lib/stellar/bindings/` altına verilir; kontrat ID'leri `app/.env` ve kök README'ye yazılır.

Başlangıç: `stellar contract init .` (Stellar CLI) — ayrıntılar için Claude'daki `stellar-dev:smart-contracts` skill'i.
