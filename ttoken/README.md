# TTOken Code: lapisan distribusi

Folder ini berisi semua yang membedakan TTOken Code dari upstream DeepSeek Harness. Sumber upstream tidak disunting tangan. Perbedaannya ditulis sebagai aturan di `apply-brand.mjs`, lalu hasil penerapannya di-commit terpisah supaya mudah ditinjau dan mudah diulang setelah merge dari upstream.

## Isi

| File | Fungsi |
|---|---|
| `brand.json` | Nama produk, app ID, skema URL, awalan nama installer, nama direktori data |
| `apply-brand.mjs` | Menerapkan semua perbedaan ke pohon sumber. Aman dijalankan berulang |
| `layer/cordis.patch.yml` | Lapisan Cordis: rute TTOken Gateway, model bawaan, telemetri upstream dimatikan |
| `icons/` | Ikon aplikasi dan tray, dirender dari `ttoken-code-app-icon.svg` di repo TTOken |
| `NOTICE.md` | Atribusi ke DeepSeek Harness |

## Yang diubah oleh `apply-brand.mjs`

1. **Nama produk** di `apps/desktop`: menu, dialog, installer Windows, nama `.app` dan `.exe`.
2. **Awalan nama installer** dan cache updater: `ttoken-code-…`, termasuk skrip unggah dan publisher yang mencari artefak lewat awalan itu.
3. **App ID**: `dev.ttoken.code`, supaya OS tidak menganggapnya aplikasi yang sama dengan build resmi.
4. **Skema URL**: `ttoken-code://`. Skema internal `dsh-app` dibiarkan karena tidak didaftarkan ke OS.
5. **Direktori data**: `~/.ttoken-code`, supaya sesi, kredensial, dan kunci profil tidak dipakai bersama instalasi resmi di `~/.dsh`.
6. **Lapisan distribusi** ditanam ke Host desktop (`apps/desktop-host/src/ttoken-layer.ts`, file hasil) dan dipasang sebagai overlay terakhir.
7. **Ikon**.

## Alur kerja

```sh
node ttoken/apply-brand.mjs --dry-run   # lihat rencana
node ttoken/apply-brand.mjs             # terapkan
node ttoken/apply-brand.mjs --check     # gagal bila ada identitas upstream yang tersisa
```

Setelah merge dari upstream, jalankan `apply-brand.mjs` lagi. Aturan yang polanya sudah tidak ada di upstream akan gagal dengan pesan jelas; perbarui aturannya, jangan dilewati.

Mengubah rute Gateway atau daftar model: sunting `layer/cordis.patch.yml`, lalu jalankan `apply-brand.mjs`.

## Build

Butuh Node 24.9 ke atas dan pnpm 11.28.5. Satu dependensi diunduh dari `cdn.sheetjs.com`, jadi jaringan harus bisa menjangkaunya.

```sh
pnpm install
pnpm run package:desktop:mac:arm64:unsigned   # di Mac Apple silicon
pnpm run package:desktop:mac:x64:unsigned     # di Mac Intel
pnpm run package:desktop:win:x64:unsigned     # di Windows
```

Build Mac tanpa tanda tangan tidak butuh file konfigurasi. Build Windows, termasuk yang tanpa tanda tangan, membaca `apps/desktop/.env.windows` dan mewajibkan alamat layanan kebijakan update (`DSH_DESKTOP_MANDATORY_UPDATE_*_ORIGIN`). Lihat bagian berikut.

## Status

Dikerjakan di lingkungan tanpa toolchain upstream, jadi **belum ada yang dikompilasi atau dijalankan**. Yang sudah diperiksa: patcher idempoten, `--check` lolos, tidak ada identitas upstream tersisa di `apps/desktop` dan `apps/desktop-publisher`, dan file `.mjs` yang tersentuh lolos pemeriksaan sintaks. Build pertama di Mac adalah uji yang sebenarnya.

Test upstream di `apps/desktop/tests` ikut diganti secara mekanis supaya tetap sejalan, tetapi belum dijalankan. Test di luar `apps/desktop` yang mengandalkan `~/.dsh` bisa gagal.

## Belum dikerjakan

Urut dari yang paling menghalangi rilis:

1. **Layanan kebijakan update.** Build Windows dan build bertanda tangan mewajibkan origin kebijakan. Aplikasi menghubunginya untuk memutuskan apakah user dipaksa update. Pilihannya: sediakan endpoint di domain TTOken, atau jadikan kebijakan opsional lewat aturan baru di patcher.
2. **Update feed.** Build tanpa tanda tangan tidak punya auto-update. Build rilis butuh tempat hosting artefak milik sendiri (`DOWNLOAD_*`).
3. **Login akun DeepSeek** masih terpasang dan masih muncul di antarmuka. Perlu diganti login akun TTOken atau disembunyikan.
4. **Antarmuka web di dalam jendela** (`packages/client`, `packages/web`, `apps/web`) masih menyebut nama upstream dan memakai tema upstream. Ini dikerjakan bersama reskin.
5. **Perintah `dsh`** yang bisa dipasang aplikasi ke PATH masih bernama `dsh`.
6. **Bahasa Indonesia** belum ada di tabel locale desktop maupun installer.
7. **Tanda tangan**: Apple Developer ID dan sertifikat Windows.
8. **Penyetelan rute Gateway**: `compat` (format thinking, field max token) belum diisi dan perlu dicek saat percakapan pertama berjalan.
