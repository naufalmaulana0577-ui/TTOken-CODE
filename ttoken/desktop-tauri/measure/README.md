# Skrip ukur Fase 0

Skrip ini menghasilkan angka untuk gerbang Fase 0 (K1 di PRD): RAM dan waktu build Electron dan prototipe Tauri di Windows 11, dengan Host dan Web client yang sama. Sesuai K8, Naufal menjalankannya di laptop Windows, lalu menempel `summary.md` dan hasil `Compare-Desktop.ps1`.

## Kartu ukur

| Bagian | Keputusan |
| --- | --- |
| Operasi user | (a) start proses sampai jendela utama tampil; (b) start sampai composer bisa diketik; (c) klik sesi di sidebar sampai jawaban terakhir sesi itu tampil. Kedua build menyembunyikan jendela utama sampai halaman boot dan Host siap (Electron lewat `show: false` di `apps/desktop/src/main.ts`, prototipe dengan aturan yang sama), jadi (a) adalah titik yang sama |
| Workload | Home Harness terpisah (`%LOCALAPPDATA%\ttoken-measure\home`) dengan workspace kecil (README dan 20 modul kecil) dan sesi sintetis dari `seed-fixture.mjs`: satu sesi 240 giliran (S2) dan tiga sesi 30 giliran (S3), dengan teks, reasoning, blok kode, dan hasil tool. Isinya dari konstanta tetap, tanpa data user. Tiap peluncuran mulai dari keadaan yang sama: sesi A terbuka dan sidebar kanan bawaan, karena akhir peluncuran sebelumnya mengembalikannya. Bila pengembalian itu gagal, satu peluncuran pemulihan yang tidak dicatat mengembalikannya |
| Skenario | S1: idle 2 menit setelah composer siap. S2: buka sesi panjang, muat semua halaman lama dengan menggulir ke atas, lalu gulir ke bawah selayar demi selayar. S3: buka panel Device di sesi A, B, dan C (panel itu milik tiap sesi), buka view Issues, kembali ke Chat, lalu pindah sesi B, C, A, B, C, A |
| Jalur | Build yang dirilis: installer Electron dari CI dan exe prototipe dari CI, dengan payload instalasi Electron yang sama. Electron membaca project `dsh` dari dalam `app.asar`; Tauri membacanya sebagai berkas biasa hasil ekstrak arsip yang sama (`%LOCALAPPDATA%\ttoken-measure\payload`), seperti nanti dikirim installer Tauri. Halaman dikendalikan lewat DevTools protocol di kedua build (`--remote-debugging-port` di Electron, `TTOKEN_DESKTOP_DEBUG_PORT` di Tauri) |
| Jam | Waktu dinding sistem dalam milidetik untuk (a) dan (b): start dicatat tepat sebelum proses dibuat; (a) dari pengecekan jendela tiap 10 ms di thread tersendiri; (b) dari `Date.now()` di halaman saat composer pertama bisa diketik, dicek tiap frame. Pengamat composer dipasang lewat DevTools selagi jendela masih tersembunyi; kedua build baru merender composer setelah jendela tampil, jadi (b) tidak pernah hanya batas atas. (c) dari `event.timeStamp` tekan mouse sampai teks tampil plus dua frame, diukur di halaman. Latensi model dan jaringan tidak ikut, karena tidak ada permintaan model |
| Memori | Private working set (`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate`) semua proses di pohon proses app, termasuk `msedgewebview2.exe` atau helper Electron, dan `node.exe` Host. Lima sampel tiap detik setelah skenario selesai dan koneksi DevTools ditutup; per peluncuran dipakai median. Per jenis proses dicatat juga |
| Urutan start | Electron memuat halaman dulu, baru menjalankan Host; prototipe menjalankan Host sambil memuat halaman. Tiap peluncuran mencatat kapan Host dibuat (`hostStartMs`), dan `Compare-Desktop.ps1` menampilkannya di samping (a) dan (b), supaya bagian selisih yang datang dari urutan start tidak terbaca sebagai keunggulan Tauri |
| Putusan | Electron, Tauri, dan Tauri dengan compile cache diukur bergantian dalam satu pemanggilan, dengan urutan yang diputar per run dan skenario, dan hanya saat charger terpasang. Lima peluncuran per skenario dan build, tiap peluncuran baru; satu peluncuran pemanasan per build di awal tidak dicatat. `Compare-Desktop.ps1` memakai median, dan variasi antar-run adalah rentang nilai per run, diambil yang lebih besar dari kedua hasil. Hanya peluncuran yang selesai dan mulai dari sesi A yang dipakai. Metrik yang kehilangan run, atau yang (b)-nya hanya batas atas di salah satu hasil, dinyatakan belum bisa dinilai, baik tampak lolos maupun tidak, karena run yang hilang dan batas atas mengubah median dan variasinya |
| Perilaku | Sebelum mengukur, `-Setup` membuka tiap sesi fixture di kedua build. Jalur fungsional Tauri diuji smoke CI (`scripts/smoke.ps1`) |

Tidak masuk K1: start dingin setelah reboot (`-Cold`) dicatat terpisah, sesuai PRD, dan macOS dicatat terpisah bila ada Mac.

## Langkah

Unduh dua artifact dari run CI untuk commit yang sama di branch `ttoken/desktop-tauri`: `ttoken-code-windows-x64-unsigned` dari workflow "TTOken Code · Desktop · unsigned" (installer Electron), dan `ttoken-code-tauri-prototype-windows-x64` dari workflow "TTOken Code · Desktop · Tauri" (prototipe dan skrip ini). Semua perintah dijalankan dengan PowerShell 7 dari folder hasil ekstrak artifact prototipe (berisi `ttoken-code-desktop.exe`, folder `measure`, dan folder `scripts`).

0. Berkas yang diunduh dari halaman Actions ditandai Windows sebagai berkas dari internet, dan PowerShell 7 menolak menjalankan skrip bertanda itu yang tidak bertanda tangan. Hapus tandanya sekali dari folder hasil ekstrak:

   ```powershell
   Get-ChildItem -Recurse | Unblock-File
   ```

1. Pasang installer Electron. Keluar dari TTOken Code, termasuk dari tray; skrip berhenti bila TTOken Code milikmu masih berjalan, karena proses sisa pengukuran dihentikan paksa. Tutup juga aplikasi lain yang berat, dan colokkan charger.
2. Siapkan home ukur sekali. Skrip mengekstrak project `dsh` dari `app.asar` instalasi Electron ke folder kerja (beberapa menit), membuat sesi fixture, lalu membuka TTOken Code dengan home ukur. Isi API key TTOken Gateway di layar sambutan, tunggu jendela utama tampil, lalu tekan Enter di terminal.

   ```powershell
   pwsh -File measure/Measure-Desktop.ps1 -Setup
   ```

3. Ukur ketiga build bergantian. Ini memakan sekitar 90 menit; charger tetap terpasang, laptop jangan dipakai, dan layarnya jangan ditutup. Selama skrip berjalan, Windows ditahan agar tidak tidur dan layar tidak mati, tetapi screen saver tidak ikut ditahan: bila laptop memakai screen saver yang mengunci layar, matikan dulu. Skrip berhenti bila compile cache Node masih kosong setelah pemanasan, dan bila laptop pindah ke baterai.

   ```powershell
   pwsh -File measure/Measure-Desktop.ps1
   ```

4. Bandingkan. Folder hasil dicetak di akhir pengukuran; isinya `electron.json`, `tauri.json`, `tauri-cache.json`, dan `summary.md`.

   ```powershell
   pwsh -File measure/Compare-Desktop.ps1 -Electron <folder>\electron.json -Tauri <folder>\tauri.json -OutputPath k1.md
   pwsh -File measure/Compare-Desktop.ps1 -Electron <folder>\tauri.json -Tauri <folder>\tauri-cache.json -OutputPath d12.md
   pwsh -File measure/Compare-Desktop.ps1 -Electron <folder>\electron.json -Tauri <folder>\tauri-cache.json -OutputPath k1-cache.md
   ```

   Yang pertama adalah K1 tanpa compile cache, yang kedua menunjukkan apakah compile cache mempercepat (a) dan (b) (D12), dan yang ketiga K1 dengan compile cache.

5. Start dingin, di luar K1: reboot, login, lalu jalankan satu build. Skrip menunggu CPU dan disk tenang dulu (paling lama 15 menit), lalu meluncurkan app sekali. Ulangi dengan reboot untuk build lain; sebaiknya tiga kali per build, bergantian. Angkanya dibaca dari `summary.md`. Bila halaman prototipe belum boot dalam 30 detik, jendelanya tampil kosong karena batas waktu; start dingin itu tetap dicatat, dengan (a) diambil dari saat halaman boot di timeline shell, dan kolom "(a) dari saat boot" menandainya.

   ```powershell
   pwsh -File measure/Measure-Desktop.ps1 -Build Electron -Cold
   ```

   ```powershell
   pwsh -File measure/Measure-Desktop.ps1 -Build Tauri -Cold
   ```

Hasil ada di `%LOCALAPPDATA%\ttoken-measure\results\<nama>-<waktu>\`: satu file JSON per build (semua sampel), `summary.md`, dan timeline shell Tauri per peluncuran. Bila pengukuran berhenti di tengah, juga lewat Ctrl+C, run yang sudah selesai tetap ditulis dan ditandai, dan `Compare-Desktop.ps1` tidak memutuskan K1 dari hasil itu.

## File

| File | Fungsi |
| --- | --- |
| `Measure-Desktop.ps1` | Setup, peluncuran bergantian, skenario, dan hasil |
| `Compare-Desktop.ps1` | Tabel K1 dari dua hasil |
| `DesktopProcess.psm1` | Pohon proses, memori, deteksi jendela, screenshot |
| `Cdp.psm1` | Klien DevTools protocol minimal |
| `Scenario.psm1` | Langkah S2 dan S3, dan pengembalian keadaan awal tiap peluncuran |
| `page.js` | Pembantu di halaman: kesiapan composer, waktu ganti sesi, muat riwayat, gulir, sesi terbuka, layout sidebar |
| `seed-fixture.mjs` | Sesi sintetis S2 dan S3, ditulis lewat persistence JSONL bawaan |
| `../scripts/extract-payload.mjs` | Project `dsh` dari `app.asar` instalasi Electron sebagai berkas biasa, untuk prototipe Tauri dan pembuat fixture |
