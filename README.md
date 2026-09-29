# PIXEL WALL 10K — FINAL 7.0

Website monetisasi 10.000 pixel. Pengunjung memilih pixel, mengisi nama/brand, pesan, link, dan gambar, lalu membayar melalui Midtrans. Order disimpan di PostgreSQL/Supabase, gambar di Supabase Storage, dan admin dapat memoderasi listing.

## Yang sudah termasuk

- 10.000 pixel dalam grid 100 × 100.
- Harga dapat diatur melalui `PIXEL_PRICE_IDR` (default Rp1.000/pixel).
- Pemilihan banyak pixel sekaligus.
- Reservasi pembayaran 15 menit.
- **Atomic pixel claim** di PostgreSQL dengan `pixel_claims.pixel_id` sebagai primary key untuk mencegah double-booking saat dua checkout terjadi bersamaan.
- Midtrans Snap Sandbox/Production.
- Webhook Midtrans + verifikasi SHA-512 + validasi gross amount.
- Polling status order setelah pembayaran.
- Supabase Storage untuk gambar.
- Batas upload 3 MB: PNG/JPG/WEBP.
- Validasi URL website.
- Moderasi listing visible/hidden.
- Admin dashboard + login + logout + session expiry.
- Rate limit untuk login, checkout, dan upload.
- Helmet security headers + CORS.
- Health check `/health`.
- SEO dasar + `robots.txt`.
- Docker-ready.
- Database schema otomatis saat startup dan `schema.sql` sebagai backup/manual migration.

## Arsitektur

Browser → Express/Node.js → PostgreSQL/Supabase Database
                         ↘ Supabase Storage
                         ↘ Midtrans Snap/Webhook

Secret key hanya berada di server environment variables. Jangan commit `.env`.

## 1. Supabase

Buat satu project Supabase.

### Database

Gunakan connection string PostgreSQL project tersebut sebagai `DATABASE_URL`.

Server akan membuat tabel berikut saat startup:

- `orders`
- `order_pixels`
- `pixel_claims`

File `schema.sql` tersedia jika ingin menjalankan schema secara manual.

### Storage

Bucket yang digunakan:

`pixel-assets`

Jika bucket belum ada, server mencoba membuatnya otomatis memakai `SUPABASE_SECRET_KEY`. Bucket dibuat public agar gambar listing dapat ditampilkan di halaman publik.

## 2. Midtrans

Ambil:

- Server Key
- Client Key

Untuk Sandbox:

`MIDTRANS_IS_PRODUCTION=false`

Untuk Production:

`MIDTRANS_IS_PRODUCTION=true`

Set Notification URL Midtrans ke:

`https://DOMAIN-KAMU/api/midtrans/webhook`

Jangan menaruh Server Key di frontend.

## 3. Environment variables

Salin `.env.example` dan isi:

```env
PORT=3000
NODE_ENV=production
PUBLIC_BASE_URL=https://domain-kamu.com
PIXEL_PRICE_IDR=1000
DB_POOL_MAX=10

DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres

MIDTRANS_SERVER_KEY=...
MIDTRANS_CLIENT_KEY=...
MIDTRANS_IS_PRODUCTION=false

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SECRET_KEY=...
SUPABASE_BUCKET=pixel-assets

ADMIN_PASSWORD=buat-password-admin-yang-panjang-dan-unik
```

**Jangan kirim nilai secret ke chat, GitHub, atau frontend.**

## 4. Deploy

### Docker

```bash
docker build -t pixel-wall-10000 .
docker run --env-file .env -p 3000:3000 pixel-wall-10000
```

### Node.js hosting

Build/install:

```bash
npm install
```

Start command:

```bash
npm start
```

Hosting harus meneruskan `PORT` dari environment. HTTPS sangat disarankan karena checkout dan admin berjalan melalui web.

## 5. Setelah online

Cek:

- `https://DOMAIN-KAMU/` → website publik
- `https://DOMAIN-KAMU/admin` → admin
- `https://DOMAIN-KAMU/health` → status server
- `https://DOMAIN-KAMU/api/midtrans/webhook` → endpoint webhook Midtrans

## 6. Urutan test Sandbox

1. Buka wall dari HP.
2. Pilih beberapa pixel.
3. Isi nama/brand.
4. Upload gambar.
5. Isi website jika ada.
6. Centang persetujuan.
7. Checkout.
8. Selesaikan pembayaran Sandbox.
9. Tunggu webhook.
10. Pastikan pixel berubah menjadi terjual.
11. Pastikan listing muncul di Gallery.
12. Login `/admin`.
13. Coba Hide/Show listing.
14. Pastikan listing hidden tidak muncul di publik.
15. Coba dua browser memilih pixel yang sama; hanya satu order yang boleh berhasil mengklaim pixel tersebut.

## 7. Go Live

Setelah Sandbox stabil:

1. Ganti Midtrans ke credential Production.
2. Set `MIDTRANS_IS_PRODUCTION=true`.
3. Pastikan `PUBLIC_BASE_URL` menggunakan domain HTTPS production.
4. Pastikan Notification URL Midtrans memakai domain production.
5. Deploy ulang.
6. Lakukan satu transaksi nyata bernilai kecil untuk smoke test.

## Catatan operasional

- `SUPABASE_SECRET_KEY`, `DATABASE_URL`, dan `MIDTRANS_SERVER_KEY` hanya server-side.
- Admin session disimpan in-memory pada instance Node. Untuk multi-instance/scale-out besar, gunakan persistent session store atau auth provider.
- Backup PostgreSQL secara berkala.
- Bucket Storage public berarti URL gambar yang sudah dipasang pada listing dapat diakses publik.
- Moderasi `hidden` tidak menghapus kepemilikan pixel; pixel tetap dianggap terjual.
