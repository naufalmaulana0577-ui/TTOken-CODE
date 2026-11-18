# TTOken Code: lapisan distribusi

Folder ini berisi semua yang membedakan TTOken Code dari upstream DeepSeek Harness. Sumber upstream tidak disunting tangan. Perbedaannya ditulis sebagai aturan di `apply-brand.mjs`, lalu hasil penerapannya di-commit terpisah supaya mudah ditinjau dan mudah diulang setelah merge dari upstream.

## Isi

| File | Fungsi |
|---|---|
| `brand.json` | Nama produk, app ID, skema URL, awalan nama installer, nama direktori data |
| `apply-brand.mjs` | Menerapkan semua perbedaan ke pohon sumber. Aman dijalankan berulang |
| `layer/cordis.patch.yml` | Lapisan Cordis: rute TTOken Gateway, model bawaan, telemetri upstream dimatikan, plugin yang terikat layanan DeepSeek dimatikan |
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
11. **Layar sambutan** meminta API key TTOken Gateway. Tombol masuk dengan akun TTOken tampil hanya bila `accountLogin` di `brand.json` menyala.
12. **Merek di dalam jendela**: mark dan wordmark (`FishLogo`, `BrandWordmark` di `ui-primitives`), nama build di sidebar, judul jendela, judul beranda, indikator berjalan, dan dekorasi paus piksel di beranda yang tidak lagi dipasang.
13. **Identitas agent** di prompt sistem: model memperkenalkan diri sebagai TTOken Code.
14. **Teks antarmuka** di semua kamus bahasa: "DeepSeek Harness", "DSH", dan "Harness" menjadi TTOken Code; contoh perintah `dsh` di dalam kurung dihapus. Hanya isi literal string yang disentuh.
15. **Menu "Manage dsh Command"** dihapus.
16. **Layar sambutan**: mark di tengah, nama produk di bawahnya, dan satu baris "Powered by DeepSeek Harness". Ini satu-satunya tempat nama upstream terlihat user; aturan lain melewati frasa itu.
17. **Terjemahan reasoning** tetap memakai Bing atau Google; rute berbayar DeepSeek Flash tidak ditawarkan.
18. **Prompt model** di plugin konteks mode Creator dan rekomendasi menyebut TTOken Code.
19. **Halaman Plugins** tidak menampilkan nama paket upstream, dan paket di `HIDDEN_PACKAGES` tidak didaftar sama sekali, supaya tidak bisa dinyalakan lagi dari sana. Contoh nama paket di dialog instal menjadi `@author/plugin-name`.
20. **Login akun TTOken.** Plugin akun upstream diarahkan ke rute `/api/v1/code/desktop` di ttoken.dev (`docs/CODE-DESKTOP.md` di repo TTOken): alamat rute, header token, halaman persetujuan, saldo Rupiah, teks "akun TTOken" di delapan bahasa. Key perangkat hasil login otomatis menjadi API key rute TTOken Gateway (`host/account-key-mirror.ts`), jadi rute model akun DeepSeek tidak dipakai. Pemakaian dan Isi saldo membuka dashboard ttoken.dev di browser. Layanan akunnya selalu menyala karena layar sambutan membaca statusnya; antarmukanya (`layer/account.patch.yml`) dan tombol masuk menyala lewat `accountLogin`.
21. **Pencarian web lewat TTOken Gateway.** Plugin pencarian web upstream memakai `POST /v1/tools/search` di api.ttoken.dev dengan API key rute Gateway (`layer/web.patch.yml`, saklar `webSearch`). Penyedia Fetch plugin itu tidak didaftarkan karena TTOken tidak menyediakan pengambilan halaman; `web_fetch` tetap memakai web-fetch-http di perangkat user. Pesan error dan nama plugin menyebut TTOken.
22. **Palet TTOken Code** (`client/palette.ts`): satu lapisan override token tema dipasang di ui-theme. Skema terang memakai permukaan putih hangat (#F9F9F7) dan tombol hitam sesuai desain desktop; skema gelap memakai hitam netral seperti GitHub. Gelembung pesan user, sidebar, chip, kode, dan diff mengikuti token ini.
23. **Fon** Inter untuk teks dan JetBrains Mono untuk kode (`fonts/`, lisensi SIL OFL) dibundel di ui-theme dan menjadi tumpukan bawaan, termasuk di jendela sambutan.
24. **Composer sesuai desain**: chip opsi di atas kartu (izin, folder kerja, cabang Git, lalu mark), tombol kirim ↵ di dalam kartu, menu mode dan model di bawahnya (`client/composer/`). Menu mode (`client/plan/`) memilih Agent mode atau Plan mode lewat perintah `/plan` dan `/plan off`. Chip folder membuka menu konteks folder; chip cabang membaca berkas HEAD lewat Remote `workspaceFiles`. Placeholder menjadi "Ask Code or describe a change" di delapan bahasa.
24d. **Batas langkah per tugas.** Penjaga loop repeat-tool-reminder mendapat field volatile `stepLimit` (bawaan 20, `0` mati). Langkah dihitung per agent sejak pesan user terakhir; langkah setelah batas membawa catatan agar model berhenti, merangkum, dan bertanya; dua langkah setelahnya ditolak. Chip "20 steps" di samping model mengubahnya lewat namespace pengaturan `repeat-tool-reminder`.
24e. **Papan issue GitHub, sisi Host** (`forge/types.ts.part`, `forge/issues.ts`). Paket forge mendapat metode opsional `listIssues`; forge-github membaca 50 issue terbuka dan 10 issue tertutup terakhir dalam satu permintaan GraphQL lewat `gh`, lengkap dengan label, assignee, akun yang login, dan pull request yang menutup issue beserta status cek-nya. Remote panel forge mendapat `issues(session)` untuk repositori checkout Session.
24f. **Papan issue GitHub, sisi Client** (`forge/client/`). Tab "Issues" di samping Chat dan Trajectory: permukaan gelap kontras tinggi di kedua tema, empat kolom (To do, Agent working, In review, Done), filter All/Agent/Mine, pencarian, sinkron tiap menit dan saat jendela kembali fokus, serta tombol New issue ke GitHub. Panel detail membuka sesi agen baru dengan issue sebagai draf pesan pertama dan worktree di cabang `ttoken/<nomor>-<judul>`; untuk pull request yang cek-nya gagal tersedia "Fix with agent". Sesi yang dimulai dari papan diingat di penyimpanan browser per repositori. Papan ini ikut bundel "Change requests & worktrees" yang harus dinyalakan di halaman Plugins dan butuh `gh` yang sudah login.
25. **Diff**: baris yang ditambah blok hijau, yang dihapus blok merah, teks kode tetap terbaca.
26. **Warna awal bilah judul Windows** mengikuti palet sebelum halaman selesai dimuat.



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
3. **Menyalakan login akun dan pencarian web.** Sisi aplikasi sudah siap (aturan 20 dan 21). Server ada di branch `feat/code-desktop-login` dan `feat/code-desktop-web-search` (bertumpuk) di repo TTOken. Setelah API dan web itu ter-deploy: set `"accountLogin": true` di `brand.json`; bila `DEEPSEEK_SEARCH_API_KEY` (pencarian native DeepSeek Flash) atau `BRAVE_SEARCH_API_KEY` sudah dipasang di server, set juga `"webSearch": true`. Lalu jalankan `node ttoken/apply-brand.mjs`, commit, push.
4. **Tampilan di dalam jendela.** Palet, fon, composer, menu mode, dan diff sudah mengikuti desain (aturan 22 sampai 26). Batas langkah per tugas sudah ada (aturan 24d). Papan issue GitHub sudah ada (aturan 24e dan 24f). Belum: chip Web (butuh kontrol sesi di Host dan pencarian web menyala), pesan yang terlihat saat langkah ditolak, bilah status tugas, dan panel Perangkat. Penyebutan nama upstream yang tersisa di teks pengaturan dan bantuan perlu disisir.
5. **Tagline layar sambutan** masih milik DeepSeek ("Build potential. Explore intelligence.", kunci `welcomeDescription` di `apps/desktop/src/locale.ts`, delapan bahasa). Menunggu tagline TTOken dari pemilik produk.
6. **Analitik** masih mati; butuh kolektor OTLP milik TTOken dan pembaruan kebijakan privasi.
7. **Perintah `dsh`** yang bisa dipasang aplikasi ke PATH masih bernama `dsh`.
8. **Bahasa Indonesia** belum ada di tabel locale desktop maupun installer.
9. **Tanda tangan**: Apple Developer ID dan sertifikat Windows.
10. **Penyetelan rute Gateway**: `compat` (format thinking, field max token) belum diisi dan perlu dicek saat percakapan pertama berjalan.

## Yang sengaja dimatikan

`layer/cordis.patch.yml` dan `layer/account.patch.yml` mematikan tiga kelompok plugin. Halaman Plugins tidak mendaftar semuanya (`HIDDEN_PACKAGES` di `apply-brand.mjs`):

- **Tetap mati**, karena hanya berguna dengan layanan DeepSeek, mengirim data ke sana, atau digantikan rute TTOken Gateway: provider resmi DeepSeek dan pendukungnya, rute model akun DeepSeek, unggahan log sesi, pencarian native DeepSeek, impor chat dari situs DeepSeek, berbagi sesi lewat server terpisah, skill lencana DSH, dan halaman pengaturan pencarian web (pilihan penyedia dan cara bayarnya khusus DeepSeek).
- **Mati sampai server TTOken siap**: analitik. Alamat bawaannya adalah kolektor DeepSeek. Begitu diarahkan, hapus barisnya dari lapisan dan namanya dari `PENDING_PACKAGES`.
- **Antarmuka login akun** (selama `accountLogin` mati) dan **pencarian web** (selama `webSearch` mati).

Layanan akun (`deepseek-account`) selalu menyala tetapi tidak didaftar di halaman Plugins: tanpa layanan itu layar sambutan gagal membaca status akun dan aplikasi gagal saat mulai.

## Nama upstream yang masih ada

Tidak terlihat dalam pemakaian biasa, tetapi masih ada:

- `LICENSE` dengan baris hak cipta DeepSeek. Lisensi MIT mewajibkannya ikut dalam setiap distribusi; jangan dihapus.
- Nama paket internal `@deepseek-ai/dsh-*` di dalam folder instalasi.
- Teks antarmuka milik plugin yang dimatikan, dan teks yang hanya muncul untuk provider DeepSeek resmi.
- Nama model dari DeepSeek di daftar model Gateway, misalnya DeepSeek V4.1 Flash. Itu nama model yang dijual, bukan jejak upstream.
