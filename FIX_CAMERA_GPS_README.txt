ZONA360 V2 - CAMERA + GPS NATIVE BRIDGE FIX

ROOT CAUSE DARI VIDEO TEST:
- MainActivity mendaftarkan plugin custom Capacitor setelah super.onCreate().
- Bridge Capacitor sudah terbuat lebih dulu, sehingga Geolocation / scanner / BarcodeFiles / BackgroundGPS tidak terdaftar sebagai implementasi Android.
- Efek yang terlihat: "Geolocation plugin is not implemented on android" dan tombol Buka kamera tidak bekerja.

PERBAIKAN:
1. Semua registerPlugin(...) dipindahkan SEBELUM super.onCreate().
2. Scanner sekarang meminta CAMERA permission secara native sebelum membuka scanner.
3. Manifest permission lama dipertahankan.
4. Design HTML/CSS/JS tidak diubah.
5. Firebase/database/package tidak diubah.
6. versionCode dinaikkan ke 2026083102 agar build fix mudah dibedakan.

TEST WAJIB SETELAH BUILD:
- Login Sales -> prompt Location muncul -> GPS Sales Realtime tidak boleh lagi menampilkan "not implemented".
- Tekan Buka kamera -> prompt Camera muncul jika belum pernah diizinkan -> scanner terbuka.
- Kunci layar/minimize setelah GPS aktif -> cek Monitoring Admin.
