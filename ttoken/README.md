# TTOken Code: lapisan distribusi

Folder ini berisi semua yang membedakan TTOken Code dari upstream DeepSeek Harness. Sumber upstream tidak disunting tangan. Perbedaannya ditulis sebagai aturan di `apply-brand.mjs`, lalu hasil penerapannya di-commit terpisah supaya mudah ditinjau dan mudah diulang setelah merge dari upstream.

## Isi

| File | Fungsi |
|---|---|
| `brand.json` | Nama produk, app ID, skema URL, awalan nama installer, nama direktori data |
| `apply-brand.mjs` | Menerapkan semua perbedaan ke pohon sumber. Aman dijalankan berulang |
| `layer/cordis.patch.yml` | Lapisan Cordis: rute TTOken Gateway, model bawaan, telemetri upstream dimatikan |
| `icons/` | Ikon aplikasi dan tray, dirender dari `ttoken-code-app-icon.svg` di repo TTOken |
| `installer/`, `renderer/`, `web/` | Gambar merek installer, merek layar sambutan, dan favicon |
| `client/` | Wordmark dan mask indikator berjalan untuk antarmuka di dalam jendela |
| `NOTICE.md` | Atribusi ke DeepSeek Harness |

## Yang diubah oleh `apply-brand.mjs`

1. **Nama produk** di `apps/desktop`: menu, dialog, installer Windows, nama `.app` dan `.exe`.
2. **Awalan nama installer** dan cache updater: `ttoken-code-…`, termasuk skrip unggah dan publisher yang mencari artefak lewat awalan itu.
3. **App ID**: `dev.ttoken.code`, supaya OS tidak menganggapnya aplikasi yang sama dengan build resmi.
4. **Skema URL**: `ttoken-code://`. Skema internal `dsh-app` dibiarkan karena tidak didaftarkan ke OS.
5. **Direktori data**: `~/.ttoken-code`, supaya sesi, kredensial, dan kunci profil tidak dipakai bersama instalasi resmi di `~/.dsh`.
6. **Lapisan distribusi** ditanam ke Host desktop (`apps/desktop-host/src/ttoken-layer.ts`, file hasil) dan dipasang sebagai overlay terakhir.
7. **Kebijakan update wajib** hanya untuk build bertanda tangan. Upstream sudah begitu di macOS; Windows disamakan supaya installer uji bisa dibangun sebelum layanan kebijakan milik TTOken ada.
8. **Ikon**.
9. **Gambar merek** installer, layar sambutan, dan favicon. Aset upstream memuat logo resmi DeepSeek Harness. Penggantinya dibangun oleh `installer/generate-brand-assets.py` dari mark TTOken Code dan font Bricolage Grotesque milik web TTOken.
10. **Penerbit** di metadata `.exe`, serta kunci registry dan nama mutex perintah PATH.
11. **Layar sambutan** meminta API key TTOken Gateway dan tidak menawarkan login akun DeepSeek.
12. **Merek di dalam jendela**: mark dan wordmark (`FishLogo`, `BrandWordmark` di `ui-primitives`), nama build di sidebar, judul jendela, judul beranda, indikator berjalan, dan dekorasi paus piksel di beranda yang tidak lagi dipasang.

## Alur kerja

```sh
node ttoken/apply-brand.mjs --dry-run   # lihat rencana
node ttoken/apply-brand.mjs             # terapkan
node ttoken/apply-brand.mjs --check     # gagal bila ada identitas upstream yang tersisa
```

Setelah merge dari upstream, jalankan `apply-brand.mjs` lagi. Aturan yang polanya sudah tidak ada di upstream akan gagal dengan pesan jelas; perbarui aturannya, jangan dilewati.

Mengubah rute Gateway atau daftar model: sunting `layer/cordis.patch.yml`, lalu jalankan `apply-brand.mjs`.

## Build

### Lewat GitHub Actions (tanpa toolchain lokal)

Workflow `.github/workflows/ttoken-desktop-unsigned.yml` membangun installer Windows x64 dan DMG macOS Apple silicon tanpa tanda tangan di runner milik GitHub. Ia berjalan pada setiap push ke branch `ttoken/**`. Hasilnya ada di halaman run, bagian Artifacts:

- `ttoken-code-windows-x64-unsigned`: installer `.exe`
- `ttoken-code-mac-arm64-unsigned`: `.dmg`
- `packaging-logs-…`: log tiap tahap, ada juga saat build gagal

Actions di sebuah fork mati secara bawaan. Aktifkan sekali lewat tab Actions di halaman repo.

Installer tanpa tanda tangan memunculkan peringatan SmartScreen di Windows dan Gatekeeper di macOS, dan menampilkan label build lokal di dalam aplikasi. Ini untuk uji internal.

### Lokal

Butuh Node 24.9 ke atas dan pnpm 11.28.5. Windows juga butuh Git, PowerShell 7, tar, Python, Visual C++ Build Tools, dan Windows SDK. Satu dependensi diunduh dari `cdn.sheetjs.com`, jadi jaringan harus bisa menjangkaunya.

```sh
pnpm install --frozen-lockfile
pnpm run package:desktop:win:x64:unsigned     # di Windows x64
pnpm run package:desktop:mac:arm64:unsigned   # di Mac Apple silicon
pnpm run package:desktop:mac:x64:unsigned     # di Mac Intel
```

Build Windows membaca `apps/desktop/.env.windows`. Untuk build tanpa tanda tangan cukup satu baris: `DSH_DESKTOP_APP_ID=dev.ttoken.code`. Build Mac tanpa tanda tangan tidak butuh file konfigurasi.

## Status

Dikerjakan di lingkungan tanpa toolchain upstream, jadi **belum ada yang dikompilasi atau dijalankan**. Yang sudah diperiksa: patcher idempoten, `--check` lolos, tidak ada identitas upstream tersisa di `apps/desktop` dan `apps/desktop-publisher`, dan file `.mjs` yang tersentuh lolos pemeriksaan sintaks. Run pertama workflow di atas adalah uji yang sebenarnya.

Test upstream di `apps/desktop/tests` ikut diganti secara mekanis supaya tetap sejalan, tetapi belum dijalankan. Test di luar `apps/desktop` yang mengandalkan `~/.dsh` bisa gagal, dan test `requires policy outside local macOS builds` kini gagal untuk kasus tanpa tanda tangan karena perilakunya memang diubah.

## Belum dikerjakan

Urut dari yang paling menghalangi rilis:

1. **Layanan kebijakan update.** Build bertanda tangan mewajibkan origin kebijakan. Aplikasi menghubunginya untuk memutuskan apakah user dipaksa update. Sebelum rilis publik perlu endpoint di domain TTOken.
2. **Update feed.** Build tanpa tanda tangan tidak punya auto-update. Build rilis butuh tempat hosting artefak milik sendiri (`DOWNLOAD_*`).
3. **Login akun DeepSeek** sudah disembunyikan dari layar sambutan, tetapi plugin akunnya masih terpasang dan masih bisa muncul di pengaturan. Perlu diganti login akun TTOken.
4. **Tampilan di dalam jendela** sudah bermerek TTOken Code, tetapi tema warna, tata letak tiga kolom, dan teks antarmukanya masih milik upstream. Tahap berikutnya: token tema TTOken, lalu tata letak baru. Penyebutan nama upstream yang tersisa di teks pengaturan dan bantuan perlu disisir.
5. **Tagline layar sambutan** masih milik DeepSeek ("Build potential. Explore intelligence.", kunci `welcomeDescription` di `apps/desktop/src/locale.ts`, delapan bahasa). Menunggu tagline TTOken dari pemilik produk.
6. **API key otomatis dari akun TTOken.** Layar sambutan sekarang meminta user menempelkan API key. Tujuannya: user login akun TTOken, lalu aplikasi menerima key Gateway tanpa disalin tangan. Butuh endpoint otorisasi di API TTOken; skema `ttoken-code://` sudah terdaftar untuk jalur baliknya.
7. **Perintah `dsh`** yang bisa dipasang aplikasi ke PATH masih bernama `dsh`.
8. **Bahasa Indonesia** belum ada di tabel locale desktop maupun installer.
9. **Tanda tangan**: Apple Developer ID dan sertifikat Windows.
10. **Penyetelan rute Gateway**: `compat` (format thinking, field max token) belum diisi dan perlu dicek saat percakapan pertama berjalan.
