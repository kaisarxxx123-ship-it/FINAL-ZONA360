# Zona360 V2 — MASTER FULL SOURCE

Ini adalah project Android/Capacitor baru yang dibuat dengan **Zona360_V2_CURRENT(1).apk sebagai MASTER tampilan dan perilaku**.

## Yang dipertahankan dari APK MASTER
- Bundle UI utama `assets/index-B5r-4bie.js` **tidak diubah**.
- CSS utama `assets/index-ZW7aGsbd.css` **tidak diubah**.
- Logo Zona360 **tidak diubah**.
- Menu, warna, layout, Produk, Order, Masukan Toko, Tambah Toko, Login Admin/Sales, dan alur web lama tetap menggunakan asset APK MASTER.
- Package tetap `com.zona360.salestracker`.
- Firebase tetap project `zona360`, Realtime Database lama, root operasional `zona360_v1`.

> Catatan penting: APK berisi bundle web hasil compile, bukan source React/TypeScript asli. Karena itu bundle hasil compile dipertahankan langsung agar desain lama tidak berubah. File `zona360-firebase.js` adalah lapisan integrasi yang memang diedit untuk perbaikan native.

## Perbaikan native yang ditambahkan
1. Ikon truck pada Monitoring Sales.
2. GPS otomatis setelah Sales login.
3. Foreground Location Service Android (`START_STICKY`, `stopWithTask=false`) agar tracking tetap berjalan saat aplikasi diminimize, layar mati, atau HP dikunci, selama Android/vendor tidak menghentikan service.
4. Tidak perlu tombol Mulai Kerja / Selesai Kerja.
5. Field/menu Area yang tidak dipakai disembunyikan dari UI aktif tanpa mengubah database lama.
6. Simpan barcode PNG ke `Pictures/Zona360` menggunakan MediaStore pada Android modern.
7. Share barcode menggunakan `content://` FileProvider dan MIME `image/png` melalui Android Share Sheet.
8. Scanner QR native.
9. Order, Feedback/Masukan, Data Toko, Produk, dan login lama dipertahankan.

## Cara build paling sederhana
1. Extract ZIP ini.
2. Buka folder `Zona360_V2_MASTER_FULL_SOURCE` di Android Studio.
3. Pastikan Android SDK 35 terpasang dan JDK 17/21 tersedia, lalu tunggu Gradle Sync.
4. Pilih **Build > Generate App Bundles or APKs > Generate APKs**.
5. APK debug biasanya ada di `app/build/outputs/apk/debug/app-debug.apk`.

Gradle wrapper diarahkan ke Gradle 8.9. File `gradlew`/`gradlew.bat` juga memiliki fallback download Gradle 8.9 saat dijalankan dari terminal. Internet diperlukan pada build pertama untuk mengunduh Gradle/dependency.

## Batas Android yang memang tidak bisa dilewati
Jika pengguna menekan **Force Stop** dari Settings Android, Android menghentikan aplikasi dan service sampai aplikasi dibuka lagi. Beberapa merek juga memiliki battery optimization agresif; foreground service adalah mekanisme Android yang digunakan project ini, tetapi pengujian perangkat fisik tetap diperlukan.

## File penting
- `app/src/main/java/com/zona360/salestracker/Zona360LocationService.java` — GPS background/foreground native
- `Zona360BackgroundGpsPlugin.java` — bridge login Sales ke service
- `Zona360GeolocationPlugin.java` — GPS foreground/fallback
- `BarcodeFilesPlugin.java` — simpan/share PNG
- `Zona360BarcodeScannerPlugin.java` — scanner QR
- `app/src/main/assets/public/zona360-firebase.js` — Firebase + integrasi UI/native
- `docs/MASTER_ASSET_HASHES.txt` — bukti hash design asset sama dengan APK MASTER
- `docs/VALIDATION_RESULTS.txt` — hasil audit statis
