# Elevator — Google Play başvuru paketi

Bu dosyadaki metinler doğrudan Play Console'a yapıştırılmak üzere hazırlandı.
Karakter sınırları parantez içinde belirtildi.

---

## 1. Herkese açık linkler (yayında)

| Alan | URL |
|---|---|
| Gizlilik politikası (Play'de **zorunlu**) | https://mobilback.yolalapp.com/legal/privacy |
| Kullanım koşulları | https://mobilback.yolalapp.com/legal/terms |
| Veri güvenliği özeti | https://mobilback.yolalapp.com/legal/data-safety |
| Finansal özellikler ve risk beyanı | https://mobilback.yolalapp.com/legal/financial-disclosure |
| Hesap ve veri silme (Play'de **zorunlu**) | https://mobilback.yolalapp.com/legal/delete-account |
| Tüm belgeler | https://mobilback.yolalapp.com/legal |

---

## 2. Mağaza girişi metinleri

### Uygulama adı (30 karakter)
```
Elevator
```

### Kısa açıklama (80 karakter)
```
Rent a trader, keep your capital locked in a Stellar smart contract.
```
(67 karakter)

### Tam açıklama (4000 karakter)
```
Elevator connects people who have capital with people who know how to trade it — and
keeps the money out of both sides' hands while they work together.

HOW IT WORKS

1. A capital owner publishes how much they want managed, for how long, and the maximum
   loss they will accept. Signing the listing moves that capital into a smart contract
   on the Stellar network.
2. Traders browse those listings and send offers with their commission and expected
   return. Capital owners browse traders the same way.
3. When an offer is accepted, the agreement terms are written into the contract.
4. The trader can swap the capital between assets inside the contract — and can never
   withdraw it.
5. At settlement the contract splits the result. Commission is paid out of profit only.
   On a loss, the trader is paid nothing.

WHY THE ESCROW MATTERS

The oldest problem in managed trading is that you have to hand your money to a stranger.
Elevator does not ask you to. Capital sits in a Soroban smart contract with an
allow-listed router and a maximum-loss floor written in. The contract rejects any trade
that would push the portfolio below that floor. There is no code path that sends the
capital anywhere except back to its owner.

YOUR KEYS STAY YOURS

Elevator is non-custodial. Your private key never leaves your wallet. The server prepares
unsigned transactions; your wallet signs them on your device. The platform cannot move,
freeze or withdraw your funds, and holds no user secret key.

FOR TRADERS

- Publish a service listing with your strategy, commission and track record
- Real market data: XLM/USDC candles over one day, one week or one month
- Quotes before you sign, showing exactly what the contract will accept and why a trade
  would be rejected
- Every trade carries a note your investor can read
- Build a public rating from settled agreements

FOR CAPITAL OWNERS

- Set your own limits: amount, duration, maximum loss
- Compare traders on their record, risk profile and commission before you commit
- Watch every trade as it lands on-chain, with the transaction hash
- Settle and rate when the term ends

BUILT ON STELLAR

Escrow runs on a Soroban smart contract. Sign-in uses SEP-10 wallet authentication — no
password, no email. Deposits and withdrawals go through independent anchors using the
published Stellar standards. Swaps route through Soroswap.

IMPORTANT

Elevator currently runs on the Stellar TEST NETWORK. Test assets have no monetary value
and cannot be exchanged for money. No real funds move.

Elevator is not a broker, bank, exchange, fund or investment adviser. Nothing in the app
is investment advice or a promise of return. Expected-return figures are estimates written
by traders, not guarantees. Trading can lose money, including all of it.

Full risk disclosure: https://mobilback.yolalapp.com/legal/financial-disclosure
Privacy policy: https://mobilback.yolalapp.com/legal/privacy
```

### Kategori
- **Kategori:** Finance
- **Etiketler:** finance, investing, crypto wallet companion
- **İçerik derecelendirmesi:** 18+ (finansal içerik)

---

## 3. Veri güvenliği (Data safety) formu cevapları

> Kaynağı koddur, uydurma değil: kullanıcı modelinde e-posta/telefon/konum/KYC alanı yok,
> istemcide reklam/analitik/çökme SDK'sı yok.

**Toplanan ve kimliğe bağlı olanlar**

| Veri türü | Amaç | Zorunlu mu |
|---|---|---|
| Kullanıcı kimlikleri (Stellar adresi, kullanıcı adı) | Uygulama işlevi, hesap yönetimi | Zorunlu |
| İsim (görünen ad) | Uygulama işlevi | Zorunlu |
| Diğer kullanıcı içeriği (bio, strateji, portfolyo, ilanlar, teklifler) | Uygulama işlevi | İsteğe bağlı |
| Mesajlar | Uygulama işlevi | İsteğe bağlı |
| Diğer finansal bilgi (beyan edilen bütçe, anlaşma tutarları) | Uygulama işlevi | İlgili özellik için zorunlu |
| Fotoğraflar (yalnızca avatar URL'si) | Uygulama işlevi | İsteğe bağlı |

**Toplanmayanlar:** e-posta, telefon, adres, konum, rehber, takvim, SMS, çağrı kaydı,
mikrofon, kamera, cihaz/reklam kimliği, ödeme kartı, banka hesabı, kimlik belgesi,
analitik/çökme verisi.

**Diğer cevaplar**
- Aktarımda şifreleniyor: **Evet** (TLS)
- Veri satılıyor mu: **Hayır**
- Reklam/pazarlama için paylaşım: **Hayır**
- Kullanıcı silme talep edebilir mi: **Evet** → silme URL'si yukarıda
- Üçüncü taraf SDK (reklam/analitik/atıf/çökme): **Yok**

---

## 4. Finansal özellikler (Financial features) beyanı

Play Console → *Uygulama içeriği* → *Finansal özellikler*.

| Soru | Cevap | Gerekçe |
|---|---|---|
| Kripto para borsası mı? | **Hayır** | Emir defteri yok, varlık alım-satımı platform üzerinden yapılmıyor; takas zincir üstü izinli router ile kontratın içinde gerçekleşiyor. |
| Kripto cüzdanı mı? | **Hayır** | Uygulama anahtar üretmiyor, saklamıyor. Harici cüzdana (Freighter) WalletConnect ile bağlanıyor. |
| Saklamalı (custodial) mı? | **Hayır** | Sunucu imzalanmamış XDR üretir; imza cihazda kullanıcının cüzdanında atılır. Sunucuda kullanıcı gizli anahtarı yok. |
| Kişisel kredi / borç verme? | **Hayır** | — |
| Yatırım danışmanlığı / portföy yönetimi? | **Hayır** | Uygulama tavsiye üretmiyor; kullanıcılar birbirini seçiyor, şartlar kontrata yazılıyor. |
| Gerçek para hareket ediyor mu? | **Hayır (şu an)** | Uygulama Stellar **test ağında** çalışıyor; test varlıklarının parasal değeri yok. |

**Beyanın dayanağı:** `random_keypair()` fonksiyonu kodda hiç çağrılmıyor (ölü kod),
`encrypt_secret` yalnızca anchor oturum JWT'si için kullanılıyor, sunucuda kullanıcı
işlemi imzalayan bir kod yolu yok.

---

## 5. Görseller

| Dosya | Boyut | Kullanım |
|---|---|---|
| `store/play-icon-512.png` | 512×512, şeffaflıksız | Uygulama ikonu |
| `store/play-feature-graphic-1024x500.png` | 1024×500 | Öne çıkan görsel |
| `store/screenshot-01-market-chart.png` | 1080×2340 | Piyasa grafiği |
| `store/screenshot-02-new-trade.png` | 1080×2340 | Kotasyonlu işlem paneli |
| `store/screenshot-03-dashboard.png` | 1080×2340 | Müşteri paneli |
| `store/screenshot-04-elevator-deck.png` | 1080×2340 | Trader keşif destesi |
| `store/screenshot-05-escrow.png` | 1080×2340 | Sermaye ilanı ve escrow |

Play en az 2, en fazla 8 telefon ekran görüntüsü ister; 1080×2340 (9:19.5) kabul edilir.
