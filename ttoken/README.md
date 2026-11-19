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
| `client/` | Palet, wordmark, beranda, sidebar, composer, mode, dan mask indikator berjalan untuk antarmuka di dalam jendela |
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
12. **Merek di dalam jendela**: mark dan wordmark (`FishLogo`, `BrandWordmark` di `ui-primitives`), nama build di sidebar, judul jendela, indikator berjalan, dan dekorasi paus piksel di beranda yang tidak lagi dipasang.
13. **Identitas agent** di prompt sistem: model memperkenalkan diri sebagai TTOken Code.
14. **Teks antarmuka** di semua kamus bahasa: "DeepSeek Harness", "DSH", dan "Harness" menjadi TTOken Code; contoh perintah `dsh` di dalam kurung dihapus. Hanya isi literal string yang disentuh.
15. **Menu "Manage dsh Command"** dihapus.
16. **Layar sambutan** (`renderer/welcome.css.part`): kertas, mark tinta di tengah, nama produk dengan Archivo, tagline "The coding agent you pay for per token." (kunci `welcomeTagline`, delapan bahasa), tombol penuh, baris "New to TTOken? Create an account at ttoken.dev", dan satu baris "Powered by DeepSeek Harness" dengan IBM Plex Mono di bawah. Halaman API key memakai mark kecil yang sama. Ini satu-satunya tempat nama upstream terlihat user; aturan lain melewati frasa itu.
17. **Terjemahan reasoning** tetap memakai Bing atau Google; rute berbayar DeepSeek Flash tidak ditawarkan.
18. **Prompt model** di plugin konteks mode Creator dan rekomendasi menyebut TTOken Code.
19. **Halaman Plugins** tidak menampilkan nama paket upstream, dan paket di `HIDDEN_PACKAGES` tidak didaftar sama sekali, supaya tidak bisa dinyalakan lagi dari sana. Contoh nama paket di dialog instal menjadi `@author/plugin-name`.
20. **Login akun TTOken.** Plugin akun upstream diarahkan ke rute `/api/v1/code/desktop` di ttoken.dev (`docs/CODE-DESKTOP.md` di repo TTOken): alamat rute, header token, halaman persetujuan, saldo Rupiah, teks "akun TTOken" di delapan bahasa. Key perangkat hasil login otomatis menjadi API key rute TTOken Gateway (`host/account-key-mirror.ts`), jadi rute model akun DeepSeek tidak dipakai. Pemakaian dan Isi saldo membuka dashboard ttoken.dev di browser. Layanan akunnya selalu menyala karena layar sambutan membaca statusnya; antarmukanya (`layer/account.patch.yml`) dan tombol masuk menyala lewat `accountLogin`.
21. **Pencarian web lewat TTOken Gateway.** Plugin pencarian web upstream memakai `POST /v1/tools/search` di api.ttoken.dev dengan API key rute Gateway (`layer/web.patch.yml`, saklar `webSearch`). Penyedia Fetch plugin itu tidak didaftarkan karena TTOken tidak menyediakan pengambilan halaman; `web_fetch` tetap memakai web-fetch-http di perangkat user. Pesan error dan nama plugin menyebut TTOken.
22. **Palet TTOken Code** (`client/palette.ts`) dari sistem desain TTOken Marketing: satu lapisan override token tema dipasang di ui-theme. Skema terang memakai kertas #F4EFE4 untuk sidebar, #FBF9F4 untuk latar, permukaan putih, tinta #16130D untuk teks dan tombol, garis hangat, dan tautan cokelat kunyit; skema gelap memakai hitam netral. Gelembung pesan user, sidebar, chip, kode, dan diff mengikuti token ini.
23. **Fon** dari sistem desain (`fonts/`, lisensi SIL OFL): Inter untuk teks, Archivo (sumbu lebar dan tebal) untuk judul dan nama produk lewat `--dsw-font-family-brand`, dan IBM Plex Mono untuk kode, label, dan path. Ketiganya dibundel di ui-theme dan menjadi tumpukan bawaan, termasuk di jendela sambutan.
24. **Composer dari desain terang** (`client/composer/`, `client/plan/`): kartu putih datar dengan garis tipis tegas, tanpa bayangan. Semua kontrol ada di baris bawah kartu: tombol perintah, tombol bersegmen Agent/Plan (lewat perintah `/plan` dan `/plan off`), chip izin, lalu model, batas langkah, dan tombol kirim bulat hitam. Chip folder kerja dan cabang Git pindah ke samping judul sesi sebagai label mono; chip folder membuka menu konteks folder, chip cabang membaca berkas HEAD lewat Remote `workspaceFiles`. Placeholder menjadi "Ask Code or describe a change" di delapan bahasa.
24d. **Batas langkah per tugas.** Penjaga loop repeat-tool-reminder mendapat field volatile `stepLimit` (bawaan 20, `0` mati). Langkah dihitung per agent sejak pesan user terakhir; langkah setelah batas membawa catatan agar model berhenti, merangkum, dan bertanya; dua langkah setelahnya ditolak. Chip "20 steps" di samping model mengubahnya lewat namespace pengaturan `repeat-tool-reminder`.
24e. **Papan issue GitHub, sisi Host** (`forge/types.ts.part`, `forge/issues.ts`). Paket forge mendapat metode opsional `listIssues`; forge-github membaca 50 issue terbuka dan 10 issue tertutup terakhir dalam satu permintaan GraphQL lewat `gh`, lengkap dengan label, assignee, akun yang login, dan pull request yang menutup issue beserta status cek-nya. Remote panel forge mendapat `issues(session)` untuk repositori checkout Session.
24f. **Papan issue GitHub, sisi Client** (`forge/client/`). Tab "Issues" di samping Chat dan Trajectory: permukaan gelap kontras tinggi di kedua tema, empat kolom (To do, Agent working, In review, Done), filter All/Agent/Mine, pencarian, sinkron tiap menit dan saat jendela kembali fokus, serta tombol New issue ke GitHub. Panel detail membuka sesi agen baru dengan issue sebagai draf pesan pertama dan worktree di cabang `ttoken/<nomor>-<judul>`; untuk pull request yang cek-nya gagal tersedia "Fix with agent". Sesi yang dimulai dari papan diingat di penyimpanan browser per repositori. Papan ini ikut bundel "Change requests & worktrees" yang harus dinyalakan di halaman Plugins dan butuh `gh` yang sudah login.
24g. **Kartu status tugas** (`client/composer/TaskStatus.tsx`): selama agen bekerja, kartu di atas composer menampilkan mark, "Code", "Agent session · <folder>", dan "In progress · <waktu>" dengan tombol sembunyikan untuk run itu. Waktu dihitung sejak jendela ini pertama melihat run berjalan.
25. **Diff**: baris yang ditambah blok hijau, yang dihapus blok merah, teks kode tetap terbaca.
26. **Warna awal bilah judul Windows** mengikuti palet (kertas #F4EFE4) sebelum halaman selesai dimuat.
27. **Panel Perangkat Android** (`device/`, paket baru `packages/experimental/android-device`). Tab "Device" di sidebar kanan (buka lewat tombol + di sidebar, pilih Android device): daftar perangkat dari `adb devices -l` di komputer ini, layar perangkat sekitar sekali per detik (klik = tap, seret = swipe), tombol Back, Home, Recent apps, kolom ketik teks, jendela cermin scrcpy, menu untuk menyalakan emulator (AVD) Android Studio, dan tombol "Ask the agent to use this device" yang menambah catatan ke draf pesan supaya agen memakai perangkat lewat adb (layar dibaca dengan `uiautomator dump` atau screenshot + `read_image`). Bila `adb` atau `emulator` tidak ada di PATH, Host juga mencari di `ANDROID_HOME`, `ANDROID_SDK_ROOT`, dan folder SDK bawaan Android Studio. Semua perintah jalan di Host, tanpa relay. Paket dimuat bundel web-app; aturan ini juga menambah alias path, referensi agregat tsconfig, dan importer lockfile (`device/lock-pairs.json`, dibuat ulang dengan pnpm bila `device/package.json` berubah).
28. **Mode GitHub menyala untuk profil baru**: template profil `web` memuat bundel "Change requests & worktrees", jadi tab Issues, halaman Code review, dan worktree langsung ada di instalasi baru. Bundel tetap bisa dimatikan di halaman Plugins; profil yang sudah ada tidak diubah, jadi di instalasi lama nyalakan sendiri di Plugins. Roster uji `WEB_PROFILE_BUNDLES` di test-support sengaja tetap memakai template asli. Gerbang `verify-default-product-isolation` mencatat paket eksperimental yang sengaja menyala di TTOken Code (bundel ini beserta paket yang dirakitnya, dan panel Perangkat) di `ttoken/default-experimental.json`; paket eksperimental lain tetap ditolak.
29. **Installer menutup TTOken Code yang masih berjalan**: kalau aplikasi masih jalan, installer dan uninstaller menawarkan menutupnya (OK/Cancel), bukan hanya menyuruh keluar dari system tray. OK menjalankan aplikasi dengan `--quit-for-installer`; build yang mengenalnya keluar rapi tanpa konfirmasi kedua, build lama hanya memunculkan jendelanya. Setelah 5 detik installer menutup paksa sisa proses `TTOken Code.exe` (`taskkill /F /T`), lalu lanjut. Cancel dan mode senyap tetap membiarkan aplikasi berjalan dan keluar dengan kode 2. Sumbernya di `ttoken/desktop/`.
30. **Layar progres installer berisi air**: logo TTOken terisi air kunyit sedikit demi sedikit, dengan persentase besar dan tahap instalasi di bawahnya serta wordmark kecil di kaki halaman. Volume air mengikuti bentuk T (batang sempit terisi lebih cepat dari palang), permukaannya bergelombang (persamaan gelombang teredam, terganggu oleh aliran masuk) dan gelembung naik lalu pecah di permukaan. Garis kursor di samping T berkedip selama instalasi. Latar memakai gradasi hangat dan cahaya kunyit di belakang logo; pita tombol judul tetap rata supaya uji piksel upstream tetap berlaku. Fisika ada di `ttoken/installer/water-fill.h` (tanpa ketergantungan Windows), gambar GDI+ di `ttoken/installer/window-frame/`.
31. **Desain terang TTOken** (kanvas "TTOken Code Desktop: Tata Letak", halaman "Redesign terang"). Tampilan terang menjadi bawaan (`DEFAULT_PREFERENCE` di ui-theme); pilihan gelap atau ikut sistem tetap ada di Settings. Beranda (`client/hero/`) menampilkan judul Archivo "What should we build in <Workspace>?" dengan satu baris petunjuk, tanpa mark dan lencana pratinjau. Sidebar (`client/sidebar/`) memakai lockup tinta tanpa label versi, tombol New session hitam bertanda +, dan garis tipis pemisah. Navigasi utamanya hanya berisi panel kerja (Code review) dan baris Device yang membuka panel Perangkat Android di sidebar kanan; Plugins dan Automation pindah ke atas kartu Settings, dan menu More upstream tidak ditampilkan (barisnya disembunyikan lewat CSS, jadi urutan dan pin upstream tetap). Sesi dan baris navigasi yang aktif berwarna putih. Kaki sidebar memakai kartu Settings dengan mark TTOken di lingkaran tinta. Gelembung pesan user menjadi kartu putih bergaris tipis. Palet, fon, composer, dan layar sambutan ada di aturan 16 dan 22 sampai 24. Test yang perilakunya berubah ikut diperbarui: tema bawaan, judul beranda, urutan kontrol composer, tombol mode, teks layar sambutan, sambungan sidebar, dan warna sesi terpilih.



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
4. **Tampilan di dalam jendela.** Desain terang sudah diterapkan: palet, fon, layar sambutan, beranda, sidebar, composer, tombol mode, dan diff (aturan 16, 22 sampai 26, dan 31). Batas langkah per tugas sudah ada (aturan 24d). Papan issue GitHub (aturan 24e dan 24f) dan panel Perangkat Android (aturan 27) sudah ada. Kartu status tugas juga sudah ada. Belum dari desain terang: kartu mulai cepat dan daftar sesi terakhir di beranda, baris Home dan Issues di navigasi sidebar (papan Issues masih tab di dalam sesi), dan kartu akun dengan nama dan saldo (butuh login akun; menu akun upstream juga belum diberi gaya kartu). Belum lainnya: chip Web (butuh kontrol sesi di Host dan pencarian web menyala), pesan yang terlihat saat langkah ditolak, dan log aksi agen di panel Perangkat. Penyebutan nama upstream yang tersisa di teks pengaturan dan bantuan perlu disisir.
5. **Analitik** masih mati; butuh kolektor OTLP milik TTOken dan pembaruan kebijakan privasi.
6. **Perintah `dsh`** yang bisa dipasang aplikasi ke PATH masih bernama `dsh`.
7. **Bahasa Indonesia** belum ada di tabel locale desktop maupun installer.
8. **Tanda tangan**: Apple Developer ID dan sertifikat Windows.
9. **Penyetelan rute Gateway**: `compat` (format thinking, field max token) belum diisi dan perlu dicek saat percakapan pertama berjalan.

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
