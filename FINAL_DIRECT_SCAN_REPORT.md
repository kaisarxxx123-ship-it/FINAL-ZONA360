# Zona360 V2 — Direct Scan / Report / GPS Status Fix

Version: 2.0.4-direct-scan-report-gps-status

## Perubahan utama

1. Menu bawah **SCAN TOKO** sekarang memanggil scanner native secara langsung. Event ditangkap sebelum React berpindah ke halaman scan lama.
2. UI scan lama (Buka kamera, Riwayat, Toko tujuan, Scan + GPS, embedded reader) disembunyikan untuk Sales.
3. Barcode hasil scan dinormalisasi dan dicocokkan otomatis ke `stores`/`barcodes`.
4. Sebelum pencocokan, Sales mencoba mengambil katalog `stores` + `barcodes` terbaru dari Firebase.
5. GPS diambil otomatis setelah toko ditemukan.
6. Kunjungan baru diberi ID unik dan ditulis atomik ke `activities/{id}` + `visits/{id}` + lastLocation Sales/User.
7. `SCAN BERHASIL` hanya tampil setelah Firebase PATCH berhasil. Jika gagal/ditolak, tampil `SCAN DITOLAK`.
8. Snapshot lokal dikonfirmasi langsung setelah Firebase berhasil sehingga History/Admin dapat refresh tanpa logout/login.
9. Kolom patch lama `TOKO YANG DIKUNJUNGI` dikembalikan menjadi `AKSI`, karena sudah ada kolom Toko dan tidak perlu duplikasi.
10. Laporan Admin mendapat filter **Sales** + **Bulan**, tetap membaca filter tanggal, menampilkan jumlah kunjungan/toko/sales dan tabel 100 data per halaman.
11. Status GPS Monitoring: update <= 2 menit = **AKTIF** (hijau), lebih lama/tidak ada = **NONAKTIF** (merah). Marker truck mengikuti status tersebut.
12. Data Toko tetap memakai Firebase yang sama. Penambahan toko melalui React/local storage bridge tetap langsung diflush ke Firebase; scan Sales juga refresh katalog remote sebelum validasi.

## Tidak diubah

- Package `com.zona360.salestracker`
- Firebase project/database/root
- Login Admin/Sales
- Produk, Order, Masukan Toko
- Barcode Admin save/share
- Background GPS native service
- Logo, warna, menu utama dan desain umum

## Catatan pengujian

- JavaScript syntax: PASS (`node --check`)
- JSON Firebase rules/google-services: PASS
- Android XML Manifest/resources: PASS
- Plugin native registration before `super.onCreate`: PASS
- Direct scan wiring: PASS (static)
- Firebase success gate before `SCAN BERHASIL`: PASS (static)
- Full Gradle build in current sandbox: NOT RUN, karena Gradle 8.9 tidak tersedia lokal dan sandbox tidak memiliki akses internet ke `services.gradle.org`.
- Tes kamera/GPS/Firebase fisik tetap harus dilakukan pada APK hasil build Android Studio.
