Zona360 V2 - HISTORY AFTER SCAN FIX

Root cause diperbaiki:
1. UI Riwayat asli membaca collection `activities` saja.
2. Scan kunjungan juga mempunyai record canonical di `visits`.
3. Jika realtime `visits` tiba lebih dulu / `activities` terlambat atau ter-overwrite, scan berhasil tetapi halaman Riwayat tampak kosong.

Fix:
- activities <-> visits sekarang dimirror dua arah.
- Sales Riwayat dan Kunjungan Terakhir membaca history gabungan/dedup.
- Admin Overview/Laporan juga memakai history gabungan.
- Setelah Firebase PATCH scan sukses, event refresh UI dipaksa langsung tanpa menunggu SSE berikutnya.
- Match user menerima userId maupun salesId.
- Duplikat tetap dicegah dengan ID/fingerprint.

Build source ini sebagai APK baru. Jangan menimpa source lama saat extract.
