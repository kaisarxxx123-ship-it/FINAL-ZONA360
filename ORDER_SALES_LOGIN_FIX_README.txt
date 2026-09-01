ZONA360 V2 - ORDER SALES + LOGIN SALES FIX
31-08-2026

Perubahan:
1. Sales login sekarang langsung masuk Riwayat Kunjungan, bukan halaman Lapangan/scan lama.
2. Menu legacy "Lapangan" dihapus dari navigasi Sales dan disembunyikan jika masih tersisa dari cache lama.
3. Dropdown produk pada Buat Order menampilkan: Nama Produk + Ukuran (ML/L) + Satuan + Harga.
4. Item Order menyimpan size/ukuran produk dan memakai price/harga dari database Produk Admin saat produk dipilih.
5. Ringkasan order menampilkan ukuran produk.
6. Normalisasi katalog tidak lagi menimpa harga/ukuran/satuan yang sudah diubah Admin. Nilai Firebase/Admin sekarang prioritas; katalog bawaan hanya fallback.
7. Seluruh perbaikan layout mobile dan kamera portrait dari source sebelumnya tetap dipertahankan.

Validasi statis:
- JavaScript bundle: PASS
- zona360-firebase.js: PASS
- Android XML: PASS
- google-services.json: PASS
- Firebase rules JSON: PASS
