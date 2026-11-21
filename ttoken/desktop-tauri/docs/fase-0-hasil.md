# Hasil Fase 0: shell Tauri

Per 21 Nov 2026 prototipe shell Tauri menjalankan Host dan Web client TTOken Code tanpa Electron. Uji fungsi ujung ke ujung lolos di Linux, dan di CI Windows (WebView2) dan macOS (WKWebView) dengan payload build Electron yang sebenarnya. Angka RAM dan waktu di Windows 11 belum ada: sesi ini berjalan di cloud, jadi sesuai K8 Naufal menjalankan skrip ukur di laptop Windows dan menempel hasilnya. Rekomendasi lanjut atau berhenti menunggu angka itu (lihat [Rekomendasi](#rekomendasi)).

## Langkah Fase 0

| Langkah PRD | Status | Hasil |
| --- | --- | --- |
| 1. Branch kerja | selesai | `ttoken/desktop-tauri` dari `ttoken/desktop-shell` di `370e2508c` |
| 2. Skrip ukur | selesai | `measure/`: skenario S1 sampai S3, build diukur bergantian, keluaran JSON dan Markdown, perbandingan K1. Logika DevTools dan skenario diuji terhadap Chromium, dan pemasangan pengamat halaman terhadap Electron 44.7.0 asli yang menjalankan aplikasi tiruan dengan urutan start `main.ts` (0 dari 20 peluncuran kehilangan pengamat); bagian proses dan jendela, termasuk pengamat jendela, jalan di CI Windows lewat smoke; `Compare-Desktop.ps1` diuji dengan hasil sintetis berbentuk hasil asli; sisanya baru diuji sintaks dan ditinjau (lihat [Tinjauan](#tinjauan-skrip-dan-prototipe)) |
| 3. Baseline Electron | menunggu Naufal | Installer `ttoken-code-windows-x64-unsigned` dari run "TTOken Code · Desktop · unsigned" untuk commit yang sama dengan kit ukur |
| 4. Prototipe | selesai | Jendela utama, Host di Node bawaan lewat socket (D3), protocol `ttoken-app` (D4), tiket WebSocket (D5), `dshDesktopBoot` |
| 5. Addon native di Node biasa | selesai | Semua jalan di Node biasa; flock memang tidak punya build Windows, juga di Electron (lihat tabel) |
| 6. Ukur prototipe, dengan dan tanpa compile cache | menunggu Naufal | Satu pemanggilan `Measure-Desktop.ps1` mengukur Electron, Tauri, dan Tauri dengan compile cache bergantian |
| 7. Job CI macOS | selesai | Prototipe dibuka di WKWebView sampai composer tampil, dengan screenshot di artifact `tauri-smoke-mac-arm64` |
| 8. Audit dan `PARITY.md` awal | selesai | `PARITY.md`: 10 global preload, 34 kanal `DESKTOP_IPC`, modul main process, kunci localStorage. CI gagal bila upstream menambah kanal atau global yang belum tercatat |
| 9. Dokumen ini | selesai | |

## Bukti fungsi

Pengembangan di Linux (WebKitGTK, build debug, render software) dengan payload yang dibangun dari repo dan home Harness baru:

- Timeline satu start: jendela dibuat 0,2 detik setelah start, Host siap 2,4 detik, WebSocket pertama lewat relay 3,3 detik, composer tampil 3,5 detik.
- Antarmuka lengkap tampil: rel ikon, Workspaces, composer, dan plugin. Folder bisa dipilih lewat dialog folder di halaman (perilaku Web), workspace dibuka, dan composer bisa diketik. Sesi fixture terbuka dengan riwayatnya, dan tab Chat, Trajectory, dan Issues ada.
- Menutup jendela: shell mengirim `shutdown`, Host menjawab `shutdown-complete` sekitar 0,2 detik kemudian dan keluar dengan kode 0, lalu shell keluar tanpa proses tersisa. Bila shell mati paksa, Host keluar sendiri karena kanal putus (handler `disconnect` Host yang sudah ada).
- Profil baru dibuat dalam kurang dari 0,1 detik dengan `initProfile` milik payload.

CI ([run Tauri 10](https://github.com/naufalmaulana0577-ui/TTOken-CODE/actions/runs/44858164100), commit `8a456ae2`) membangun build Electron dari commit yang sama, mengekstrak payloadnya, memeriksa addon, lalu membuka prototipe sampai composer tampil:

| Kejadian (detik sejak start) | Windows x64, WebView2 | macOS Apple silicon, WKWebView |
| --- | --- | --- |
| Payload diekstrak | 20.693 berkas, 443 MB, dalam 6,3 detik | 20.767 berkas, 411 MB, dalam 3,6 detik |
| Profil baru dibuat | 0,2 | 0,3 |
| Host siap | 3,9 | 2,2 |
| Jendela dibuat (masih tersembunyi) | 7,9 | 1,1 |
| Jendela tampil (halaman boot, Host siap) | 8,3 | 2,8 |
| Jendela terlihat oleh pengamat jendela skrip ukur | 8,3, yaitu 9 ms setelah tanda `window-shown` dari shell | Pengamat hanya untuk Windows |
| Composer tampil | 9,5 | 5,0 |
| Menutup app | Lewat `WM_CLOSE`: `shutdown-complete` 0,4 detik kemudian, Host keluar dengan kode 0, tidak ada proses tersisa | Smoke macOS menghentikan pohon proses |

Angka CI bukan angka K1. Runner CI adalah VM tanpa GPU, dan tiap start di sana adalah start pertama; di sana WebView2 butuh sekitar 7 detik hanya untuk membuat jendela, dan waktu WKWebView berubah-ubah antar-run (1 sampai 4 detik). Pengukuran di laptop memakai satu peluncuran pemanasan per build, lalu lima peluncuran per skenario dan build, bergantian antar-build.

## Temuan utama: project Harness ada di dalam `app.asar`

Build Electron mengemas project `dsh` (Host, Harness, dan Web client) ke dalam `app.asar`; hanya kode native (`.node`, `.dll`, `.exe`, `rg`, `spawn-helper`, paket Office) yang dikeluarkan ke `app.asar.unpacked` (`apps/desktop/scripts/electron-builder-config.mjs`). Electron, juga dalam mode Node, membaca arsip itu dengan sendirinya. Node biasa tidak bisa, jadi D2 ("Host dijalankan Node bawaan") tidak bisa memakai folder `resources` build Electron apa adanya. [Run CI kedua](https://github.com/naufalmaulana0577-ui/TTOken-CODE/actions/runs/44817106041) menunjukkannya: node-pty dan ripgrep tidak ditemukan karena paket pemiliknya hanya ada di dalam arsip. Pengembangan di Linux tidak menemukannya karena payload di sana dibangun dari repo sebagai berkas biasa.

Penanganan di Fase 0: `scripts/extract-payload.mjs` menulis project `dsh` dari `app.asar` sebagai berkas biasa. Berkas di dalam arsip dicek dengan SHA-256 dari header arsip, berkas native disalin apa adanya dari `app.asar.unpacked`, dan `runtime` ditautkan ke runtime build Electron. CI dan `Measure-Desktop.ps1 -Setup` menjalankannya sebelum memakai payload. Jadi Tauri tetap menjalankan Host dan Web client yang sama persis dengan build Electron yang diukur.

Akibatnya untuk fase berikutnya:

- Installer Tauri (Fase 4) mengirim `dsh` sebagai berkas biasa, bukan `app.asar`. Jumlah berkasnya jauh lebih banyak dari satu arsip, jadi pemindaian antivirus saat start pertama bisa lebih lama. Start dingin Tauri di Fase 0 juga membaca berkas biasa, jadi efek itu ikut terukur.
- Saat mengukur, Electron membaca project dari arsip dan Tauri dari berkas biasa. Itu memang beda arsitektur kedua build, bukan beda cara ukur.

## Status addon native di Node biasa

Di Electron, Host dan skrip paket berjalan di executable Electron dalam mode Node (`ELECTRON_RUN_AS_NODE`). Di prototipe semuanya berjalan di Node 24.21.0 dari runtime bawaan. `scripts/addon-smoke.mjs` memuat tiap addon dari payload dengan Node itu dan memakainya sekali.

| Addon | Uji | Windows x64 | macOS arm64 | Linux x64 |
| --- | --- | --- | --- | --- |
| node-pty | Buka terminal dan baca keluaran perintah | ok, lewat `cmd.exe` | ok, lewat `/bin/sh` | ok |
| sharp | Buat, ubah ukuran, dan baca gambar | ok, libvips 8.18.7 | ok | ok |
| `@deepseek-ai/node-addon-system` | Ambil flock | Tidak ada build Windows | ok | ok |
| ripgrep | Cari teks di folder | ok, ripgrep 15.0.0 | ok | ok |
| koffi | Muat FFI | ok, koffi 3.1.1 | ok | ok |
| Peluncur `node` untuk skrip paket | `runtime/bin/node(.cmd)` menjalankan Node bawaan, bukan Electron | ok, Node 24.21.0 | ok | ok |

`@deepseek-ai/node-addon-system` hanya punya build macOS dan Linux (flock POSIX dan Landlock Linux), jadi build Electron di Windows juga tidak memakainya. Pada run CI kedua, peluncur `node` di Windows sempat gagal karena kutip `cmd.exe` di skrip cek, bukan karena peluncurnya; skrip sudah diperbaiki.

## Angka pengukuran

Diisi dari `Compare-Desktop.ps1` setelah Naufal menjalankan [`measure/README.md`](../measure/README.md). Ketiga build diukur bergantian dalam satu pemanggilan, dengan charger terpasang, dan tiap peluncuran mulai dari keadaan yang sama (sesi A, sidebar kanan bawaan). Semua angka median dari lima peluncuran per skenario; memori adalah private working set seluruh pohon proses.

| Metrik | Electron | Tauri | Tauri dengan compile cache | Lolos K1 |
| --- | --- | --- | --- | --- |
| Memori total S1 (MB) | | | | |
| Memori total S2 (MB) | | | | |
| Memori total S3 (MB) | | | | |
| (a) jendela tampil (ms) | | | | |
| (b) composer bisa diketik (ms) | | | | |
| (c) ganti sesi (ms) | | | | |
| Host mulai (ms sejak start, bukan bagian K1) | | | | - |

Putusan dari `Compare-Desktop.ps1` (baris "Hasil" di tiap berkas):

| Perbandingan | Berkas | Putusan |
| --- | --- | --- |
| K1 tanpa compile cache | `k1.md` | |
| D12, hanya (a) dan (b) | `d12.md` | |
| K1 dengan compile cache | `k1-cache.md` | |

Start dingin setelah reboot, dicatat terpisah dan bukan bagian K1 (PRD, "Cara mengukur" butir 5):

| Start dingin | Electron | Tauri |
| --- | --- | --- |
| (a) jendela tampil (ms) | | |
| (b) composer bisa diketik (ms) | | |

Memori per jenis proses (shell, WebView, Host) ada di file JSON tiap build. Host dikenali dari baris perintahnya di kedua build, jadi selisih Host terlihat terpisah dari selisih shell.

Compile cache (D12), angka Linux yang bukan angka K1: Host menulis cache saat keluar normal (1.418 entri, 8,7 MB), tetapi tiga start dengan cache tidak lebih cepat dari tiga start tanpa cache (Host siap median 2,29 detik lawan 2,28 detik). Angka Windows yang menentukan. Pengukuran berhenti bila cache masih kosong setelah pemanasan build TauriCache, supaya run tanpa cache tidak terbaca sebagai "tidak ada perbedaan".

## Rekomendasi

Belum bisa diputuskan tanpa angka Windows. Aturan K1: lanjut ke Fase 1 hanya bila memori total lebih rendah di S1 sampai S3 dan (a), (b), (c) lebih cepat, masing-masing dengan selisih lebih besar dari variasi antar-run. Selain itu berhenti. `Compare-Desktop.ps1` menghitung keenam metrik itu dan menulis putusannya.

Usul cara memakai dua hasil Tauri: compile cache dipakai (D12) bila perbandingan `tauri.json` lawan `tauri-cache.json` menunjukkan (a) dan (b) lebih cepat dengan cache, tanpa error. K1 lalu dinilai dengan konfigurasi yang akan dikirim: hasil dengan cache bila D12 dipakai, tanpa cache bila tidak.

Yang perlu diperhatikan saat membaca angka:

- WebView2 berbasis Chromium, jadi selisih RAM terutama datang dari dua proses: shell (biner Rust lawan main process Electron) dan Host (Node 24.21.0 bawaan lawan executable Electron dalam mode Node). Tabel per jenis proses menunjukkan bagian mana yang turun.
- Electron membuat jendela utama tersembunyi dan baru menampilkannya setelah halaman dimuat dan Host siap. Prototipe semula menampilkan jendela kosong sejak awal, sehingga (a) Tauri pasti menang tanpa arti; sekarang prototipe memakai aturan yang sama, jadi (a) di kedua build adalah saat jendela berisi tampil. Menampilkan jendela lebih awal adalah pilihan produk yang bisa dibuat di kedua shell, bukan keunggulan Tauri.
- Electron memuat halaman dulu, baru menjalankan Host, lalu memanggil Host beberapa kali sebelum menampilkan jendela; prototipe menjalankan Host sambil memuat halaman. Putusan K1 dari `Compare-Desktop.ps1` memakai selisih utuh, sesuai bunyi K1. Baris "Host mulai" menunjukkan berapa milidetik dari selisih (a) dan (b) itu datang dari urutan start. Urutan yang sama bisa dibuat di Electron, jadi bila keunggulan (a) dan (b) hampir seluruhnya datang dari sana, rekomendasiku akan menyebutnya walaupun K1 lolos.
- Prototipe belum punya tray, satu instance, sambutan, dan jembatan `dshDesktop`, jadi shell-nya lebih ringan dari shell Fase 1. Selisih yang tipis bisa hilang setelah port penuh.
- Di tiap start, Electron menjalankan `applyRelease` (validasi runtime, migrasi pengaturan profil, profil plugin) sebelum Host jalan (`apps/desktop/src/project-manager.ts`). Prototipe hanya menyiapkan profil bila belum ada, jadi (b) Tauri sedikit diuntungkan. Biayanya belum diukur terpisah; Fase 1 menambahkannya (`PARITY.md`, baris Profil).

## Perubahan dari PRD

Cara di prototipe berikut berbeda dari bunyi PRD. Hasilnya sama, dan tidak ada file upstream yang diubah. Mohon keputusan Naufal apakah dipakai juga di Fase 1:

| Bagian PRD | Bunyi PRD | Di prototipe | Alasan |
| --- | --- | --- | --- |
| D3 | Shim kecil di desktop-host lewat aturan patcher | Modul kanal dimuat dengan `node --import` (`host/shell-channel.mjs`) | Bundel Host tidak berubah, jadi prototipe bisa memakai payload Electron yang sama persis. Tidak ada aturan patcher yang bisa bentrok saat merge upstream |
| D5 | Host menerima tiket dan asal `ttoken-app` lewat aturan patcher | Shell memeriksa tiket di relay WebSocket lokal, lalu menulis ulang handshake seperti `webRequest` Electron | Pagar asal dan verifikasi kredensial di Host adalah kode keamanan upstream. Dengan relay, Host tidak berubah dan risiko "patch tiket bentrok saat merge" hilang. Biayanya: byte WebSocket lewat proses shell di loopback |
| D5 | `apps/web/src/main.ts` dipatch supaya tidak menimpa hook | Init script membuat `__DSH_TRANSPORT__` accessor yang selalu memasang `createWebSocket` bertiket | Tidak perlu patch. Bila upstream berhenti memakai global ini, relay menolak WebSocket tanpa tiket (401) dan halaman gagal terhubung, bukan diam-diam tanpa pagar |
| D12 | `NODE_COMPILE_CACHE` di folder cache app, `module.flushCompileCache()` setelah Host siap | Skrip ukur memberi `NODE_COMPILE_CACHE`; cache ditulis saat Host keluar normal | Cukup untuk mengukur efeknya. Folder cache app dan flush setelah siap masuk Fase 1 bila D12 dipakai |
| Cara mengukur, butir 4 | Waktu (a), (b), (c) dari log bertanda waktu shell dan Host | Kedua build diukur dengan cara yang sama: (a) dari polling jendela, (b) dan (c) dari halaman lewat DevTools. Timeline shell Tauri dicatat sebagai data tambahan | Shell Electron tidak perlu diubah untuk menulis log, dan kedua build diukur dengan jam yang sama |

Verifikasi D5 (Tauri 2.12.7, wry 0.57.3, dicek dari sumbernya): Tauri tidak punya API untuk mengubah header handshake WebSocket. wry memakai `WebResourceRequested` WebView2 hanya untuk protocol aplikasinya sendiri, dan WKWebView tidak punya kait untuk permintaan WebSocket. Tiket sekali pakai berjalan di kedua platform.

## Tinjauan skrip dan prototipe

Sebelum diserahkan, kit ditinjau dalam empat putaran oleh peninjau terpisah yang mencoba mencari kegagalan konkret. Putaran pertama memakai enam peninjau: ekstraktor payload, skrip ukur (dua peninjau: alur dan modul), validitas pengukuran, jalur CI, dan shell. Putaran kedua sampai keempat meninjau perbaikan dari putaran sebelumnya. Temuan yang serius diperiksa lagi oleh peninjau lain yang mencoba membantahnya. Semua temuan dicocokkan dengan kode dan, bila bisa, dicoba ulang; temuan halaman `about:blank` di bawah direproduksi dengan Electron 44.7.0, versi yang dipakai repo. Temuan yang benar sudah diperbaiki; yang paling berpengaruh pada keputusan K1:

| Temuan | Akibat bila dibiarkan | Perbaikan |
| --- | --- | --- |
| Electron menyembunyikan jendela utama sampai halaman dimuat dan Host siap; prototipe menampilkan jendela kosong sejak awal | (a) Tauri pasti lolos tanpa arti | Prototipe memakai aturan tampil yang sama |
| Electron memuat halaman dulu, baru menjalankan Host; prototipe menjalankan keduanya bersamaan | Sebagian selisih (a) dan (b) datang dari urutan start, bukan dari shell | `hostStartMs` dicatat dan ditampilkan di samping (a) dan (b) |
| Tiap build diukur dalam blok 25 menit sendiri | Panas, baterai, atau pekerjaan latar bisa memihak satu build | Ketiga build diukur bergantian dalam satu pemanggilan, hanya dengan charger |
| Peluncuran mulai dari sesi berbeda (sesi panjang setelah S2), dan panel Device terbawa ke run berikutnya | Variasi antar-run membesar; S2 dan S3 tidak sesuai PRD | Tiap peluncuran mulai dari sesi A dan sidebar bawaan; S3 membuka panel Device di tiap sesi |
| Run yang gagal dibuang tanpa jejak, dan metrik yang kehilangan run tetap dinilai "tidak" bila tampak kalah | K1 bisa "lolos" atau "tidak lolos" dari data tidak lengkap, padahal data lengkap berkata lain | Metrik yang kehilangan run, atau yang (b)-nya hanya batas atas di salah satu hasil, selalu belum bisa dinilai |
| Pengamat composer dipasang setelah jendela tampil, padahal composer bisa siap tak lama setelahnya | (b) tercatat hanya sebagai batas atas, sehingga (b) tidak bisa dinilai | Pengamat dipasang selagi jendela masih tersembunyi, dan jendela diamati di thread tersendiri. Kedua build baru merender composer setelah jendela tampil, jadi (b) selalu teramati |
| Pemasangan awal itu bisa jatuh ke dokumen `about:blank` yang lalu diganti halaman aplikasi (Chromium sudah mencantumkan URL tujuan selagi navigasi pertama berjalan) | Pada Electron asli 4 dari 12 peluncuran kehilangan pengamat, jadi hampir tiap pengukuran berakhir belum bisa dinilai | Pengamat hanya mau dipasang di halaman aplikasi dan pemasangannya diulang sampai berhasil; 0 dari 25 peluncuran Electron kehilangan pengamat |
| Perbandingan D12, start dingin, hasil yang tidak diukur bergantian, pengukuran yang tidak sesuai PRD, dan berkas yang tertukar perannya tetap mendapat putusan | Baris putusan bisa menyesatkan, misalnya "tidak lolos K1" di bawah perbandingan D12, atau putusan D12 terbalik bila kedua berkas tertukar | D12 hanya menilai (a) dan (b) dengan putusan D12 sendiri; start dingin tanpa putusan. Hasil yang tidak bergantian, kurang dari lima run, tanpa S1 sampai S3, dengan idle S1 kurang dari 2 menit, atau yang perannya tertukar belum bisa dinilai, dengan alasannya. K1 dengan compile cache hanya berlaku bila D12 dipakai |
| Peluncuran yang tidak mulai dari sesi A tetap dihitung | Satu reset yang gagal menggeser median dan variasi | Peluncuran itu tidak dipakai; reset yang gagal diikuti satu peluncuran pemulihan yang tidak dicatat |
| Tidak ada yang menahan Windows tidur selama 90 menit tanpa input | Peluncuran gagal atau tertunda di tengah, dan sesi terkunci | Skrip menahan Windows tetap menyala; README meminta screen saver yang mengunci layar dimatikan. Versi pertama perbaikan ini gagal di awal skrip karena PowerShell membaca `0x80000003` sebagai bilangan negatif; sekarang dipakai `0x80000003u`, diuji dengan baris yang sama persis |
| Ctrl+C melewati penulisan hasil | Run yang sudah selesai hilang | Hasil ditulis di blok `finally`, jadi juga ditulis setelah Ctrl+C |
| Start dingin satu peluncuran tanpa menunggu sistem tenang, dan batas tampil 30 detik prototipe bisa terbaca sebagai (a) | Angka start dingin acak | Skrip menunggu CPU dan disk tenang. Start dingin yang tampil karena batas itu tetap dicatat dengan (a) dari saat halaman boot, supaya start yang lambat tidak hilang dari angka. Start dingin di luar K1 |
| Kit dari halaman Actions ditandai berkas internet dan ditolak PowerShell 7 | Skrip tidak jalan sama sekali | Langkah `Unblock-File` di README |
| Pengukuran menghentikan paksa proses TTOken Code milik user | Pekerjaan user hilang | Skrip berhenti bila TTOken Code milik user berjalan |
| Payload lama dihapus sebelum rename yang bisa diblokir antivirus, dan `fs.rmSync` di Windows hampir tidak menunggu di antara percobaannya | Payload hilang di tengah setup, atau setup gagal karena antivirus sebentar memegang berkas | Payload lama dipertahankan sampai yang baru terpasang, dan dipulihkan bila ekstrak terputus di antara dua rename. Rename dan hapus dicoba ulang sampai 30 detik. Sisa yang belum bisa dihapus setelah payload baru terpasang hanya memberi peringatan; bila sisa itu masih terkunci saat ekstrak berikutnya, ekstrak berhenti dengan pesan yang menyebut foldernya |
| macOS dan Linux: filter navigasi juga memblokir iframe | Browser samping (fallback iframe) dan pratinjau HTML kosong di Mac | Isi iframe dibiarkan; frame utama yang keluar dari asal aplikasi dikembalikan |
| macOS: Cmd+Q mengakhiri app tanpa `ExitRequested`, juga saat app sedang menutup | Host tidak dihentikan dengan rapi, atau tertinggal berjalan | Host juga dihentikan saat event loop berakhir, dan pemanggil kedua menunggu penghentian yang sedang berjalan |

Temuan lain yang lebih kecil (kutip `cmd.exe`, path payload relatif, screenshot gagal di CI, deteksi proses sisa, cadangan CIM untuk waktu start proses yang tidak pernah terpakai, pemasangan pengamat yang tertahan halaman sibuk melewati batas waktunya, status penahan tidur yang tidak tercatat di hasil, dan beberapa kalimat README) juga sudah diperbaiki. Komentar kode di skrip PowerShell sekarang berbahasa Inggris, sesuai aturan PRD; pesan konsol dan hasil Markdown tetap berbahasa Indonesia karena dibaca Naufal.

## Temuan lain

- PRD D6 dan uji Fase 1 "Iframe tidak melihat jembatan apa pun" tidak bisa berlaku apa adanya di Windows: WebView2 menjalankan skrip IPC Tauri sendiri (`__TAURI_INTERNALS__`) di semua frame. Jembatan TTOken berhenti sendiri di iframe, dan capability tanpa `remote` menolak command dari asal lain. Usul: uji Fase 1 memeriksa bahwa command shell ditolak dari iframe dan global `dsh*` tidak ada, bukan bahwa global Tauri tidak ada.
- Pemberitahuan pratinjau (Preview Notice) disimpan di Host, bukan di penyimpanan browser, jadi cukup dikonfirmasi sekali untuk kedua shell.
- Data halaman di localStorage asal `dsh-app://app` tidak terbawa ke asal baru. Yang penting: draf composer per sesi dan sesi dari papan Issues; daftar lengkap dan usul migrasinya di `PARITY.md`.
- Respons HTTP diteruskan utuh, tanpa streaming, karena custom protocol Tauri memakai body utuh. Web client TTOken tidak membaca stream lewat HTTP; stream lewat WebSocket.
- `host.log` belum dirotasi; rotasi masuk Fase 1 bersama log berkas.

## Setelah disetujui

Fase 1 sesuai PRD: supervisor Host lengkap (dialog pemulihan saat crash, start ulang, `--quit-for-installer`), jendela dengan bilah judul Windows kustom, layar sambutan, tray dan tutup ke latar, konfirmasi keluar, satu instance, deep link `ttoken-code://`, string shell 8 bahasa, log berkas dan DevTools, serta workflow CI yang membangun installer Windows tanpa tanda tangan. Bila perubahan D3, D5, dan D12 di atas disetujui, Fase 1 meneruskannya; bila tidak, aturan patcher untuk Host dan `main.ts` ditambahkan di Fase 1.
