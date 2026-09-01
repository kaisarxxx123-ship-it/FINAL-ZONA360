# Zona360 V2 — Final Audit 2026-08-31

Static checks: **79/79 PASS**.

## Perbaikan final yang ditemukan saat audit

- Memperbaiki logout/stop tracking agar status `NONAKTIF` sempat dikirim ke Firebase sebelum foreground service dihentikan.
- Status Admin sekarang langsung menghormati `trackingStatus=inactive`; tidak lagi tetap hijau hanya karena `lastLocation` masih baru.
- Membersihkan dashboard default Sales dari route legacy `field/Lapangan`; route aktif Sales tetap Riwayat, Scan Toko, Buat Order, dan Masukan Toko.
- VersionCode dinaikkan ke `2026083108` dan versionName ke `2.0.7-final-audited` hanya untuk membedakan build hasil audit.

## Bagian yang diperiksa

- ✅ XML app/src/main/AndroidManifest.xml
- ✅ XML app/src/main/res/xml/file_paths.xml
- ✅ XML app/src/main/res/values/strings.xml
- ✅ XML app/src/main/res/values/styles.xml
- ✅ JSON app/google-services.json
- ✅ JSON firebase/database.rules.json
- ✅ JSON app/src/main/assets/capacitor.config.json
- ✅ JSON app/src/main/assets/capacitor.plugins.json
- ✅ Manifest permission CAMERA
- ✅ Manifest permission ACCESS_FINE_LOCATION
- ✅ Manifest permission ACCESS_COARSE_LOCATION
- ✅ Manifest permission ACCESS_BACKGROUND_LOCATION
- ✅ Manifest permission FOREGROUND_SERVICE
- ✅ Manifest permission FOREGROUND_SERVICE_LOCATION
- ✅ Manifest permission POST_NOTIFICATIONS
- ✅ Manifest component MainActivity
- ✅ Manifest component PortraitCaptureActivity
- ✅ Manifest component Zona360LocationService
- ✅ Plugin registered Zona360GeolocationPlugin.class
- ✅ Plugin registered Zona360BarcodeScannerPlugin.class
- ✅ Plugin registered BarcodeFilesPlugin.class
- ✅ Plugin registered Zona360BackgroundGpsPlugin.class
- ✅ Plugins registered before super.onCreate
- ✅ Camera portrait orientation manifest
- ✅ Camera orientation locked
- ✅ Camera uses portrait capture activity
- ✅ Foreground service START_STICKY
- ✅ Foreground service type location
- ✅ Stop sync waits before stop
- ✅ GPS inactive explicitly respected
- ✅ Firebase project zona360
- ✅ Firebase database URL
- ✅ Package matches Firebase
- ✅ JS package matches Android
- ✅ Operational root zona360_v1
- ✅ Direct scan nativePlugin('CapacitorBarcodeScanner')
- ✅ Direct scan refreshStoreCatalogForScan()
- ✅ Direct scan getGpsForDirectScan()
- ✅ Direct scan saveVisitAndConfirm(activity,next,null)
- ✅ Direct scan SCAN BERHASIL
- ✅ Direct scan SCAN DITOLAK
- ✅ Atomic activities write
- ✅ Atomic visits write
- ✅ Read-back confirmation
- ✅ Admin latest visit watchdog
- ✅ History mirror activities-visits
- ✅ Sales initial page visits
- ✅ Sales login goes to visits
- ✅ Sales bottom scan exists
- ✅ Old Lapangan removed from sales nav
- ✅ Old scan hero hidden
- ✅ Area UI hiding active
- ✅ Area stripped from active models
- ✅ Bottom content safe padding
- ✅ Admin report Sales filter
- ✅ Admin report month filter
- ✅ Pagination 100
- ✅ GPS status AKTIF/NONAKTIF
- ✅ Truck marker present
- ✅ Product catalog AVITA GELAS
- ✅ Product catalog 220ML
- ✅ Product catalog EDEL BOTOL
- ✅ Product catalog 330ML
- ✅ Product catalog 600ML
- ✅ Product catalog 19L
- ✅ Order label contains size
- ✅ Order label contains price
- ✅ Order item copies current admin price
- ✅ Product migration preserves admin price
- ✅ Save barcode MediaStore
- ✅ Share barcode content URI
- ✅ Share barcode MIME image/png
- ✅ No file:// share
- ✅ App name Zona360
- ✅ Compile SDK 35
- ✅ Target SDK 35
- ✅ Min SDK 26
- ✅ Java 17
- ✅ Version audited

## Batas verifikasi

Full Gradle/Android build tidak dapat dijalankan di environment audit ini karena distribusi Gradle 8.9 tidak tersedia lokal dan host `services.gradle.org` tidak dapat di-resolve. Karena itu hasil di atas adalah audit source/static, bukan klaim pengujian kamera/GPS/Firebase pada perangkat fisik.

APK final tetap harus dibuild di Android Studio dan dites pada HP sebelum dipakai lapangan.