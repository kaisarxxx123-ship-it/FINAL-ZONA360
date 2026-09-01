# Zona360 V2 — Monitoring + Visit Sync Fix

Perubahan utama:
- Garis/rute hijau tidak lagi dirender pada Monitoring. `gpsHistory` tetap disimpan.
- Peta Monitoring pada layar sentuh tidak lagi mengambil gesture scroll vertikal.
- Scan Sales menulis secara atomik ke `zona360_v1/activities` dan `zona360_v1/visits` sebelum menampilkan status berhasil.
- Scan gagal Firebase tidak lagi menampilkan status berhasil palsu.
- Satu callback scan duplikat dalam 4 detik diabaikan.
- Admin realtime listener tetap aktif dan menerima update langsung dari Firebase EventSource.
- Badge visual Firebase Online/Realtime dihapus; koneksi Firebase tetap aktif.
- Kolom Aksi/Aktivitas pada tabel kunjungan ditampilkan sebagai `TOKO YANG DIKUNJUNGI`.
- Pagination 100 data/halaman ditambahkan untuk Jejak aktivitas, Log detail, dan Riwayat kunjungan.
- Area disembunyikan lengkap termasuk kolom tabel dan label pilihan toko.
- Halaman Sales Lapangan disederhanakan tanpa mengubah tombol/fitur utama.

Catatan Firebase Rules:
`firebase/database.rules.json` adalah rules yang kompatibel dengan struktur source ini. Rules cloud tidak bisa di-deploy hanya dengan build APK; deploy melalui Firebase Console/CLI bila rules server saat ini menolak write.
