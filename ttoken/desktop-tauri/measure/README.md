# Skrip ukur Fase 0

Skrip ini menghasilkan angka untuk gerbang Fase 0 (K1 di PRD): RAM dan waktu build Electron dan prototipe Tauri di Windows 11, dengan Host dan Web client yang sama. Sesuai K8, Naufal menjalankannya di laptop Windows, lalu menempel `summary.md` dan hasil `Compare-Desktop.ps1`.

## Kartu ukur

| Bagian | Keputusan |
| --- | --- |
| Operasi user | (a) start proses sampai jendela utama tampil; (b) start sampai composer bisa diketik; (c) klik sesi di sidebar sampai jawaban terakhir sesi itu tampil |
| Workload | Home Harness terpisah (`%LOCALAPPDATA%\ttoken-measure\home`) dengan workspace kecil (README dan 20 modul kecil) dan sesi sintetis dari `seed-fixture.mjs`: satu sesi 240 giliran (S2) dan tiga sesi 30 giliran (S3), dengan teks, reasoning, blok kode, dan hasil tool. Isinya dari konstanta tetap, tanpa data user |
| Skenario | S1: idle 2 menit setelah composer siap. S2: buka sesi panjang, muat semua halaman lama dengan menggulir ke atas, lalu gulir ke bawah selayar demi selayar. S3: buka panel Device dan view Issues, kembali ke Chat, lalu pindah sesi B, C, A, B, C, A |
| Jalur | Build yang dirilis: installer Electron dari CI dan exe prototipe dari CI, dengan payload instalasi Electron yang sama. Electron membaca project `dsh` dari dalam `app.asar`; Tauri membacanya sebagai berkas biasa hasil ekstrak arsip yang sama (`%LOCALAPPDATA%\ttoken-measure\payload`), seperti nanti dikirim installer Tauri. Halaman dikendalikan lewat DevTools protocol di kedua build (`--remote-debugging-port` di Electron, `TTOKEN_DESKTOP_DEBUG_PORT` di Tauri) |
| Jam | Waktu dinding sistem dalam milidetik untuk (a) dan (b): start dicatat tepat sebelum proses dibuat; (a) dari polling jendela tiap 10 ms; (b) dari `Date.now()` di halaman saat composer pertama bisa diketik, dicek tiap frame. (c) dari `event.timeStamp` tekan mouse sampai teks tampil plus dua frame, diukur di halaman. Latensi model dan jaringan tidak ikut, karena tidak ada permintaan model |
| Memori | Private working set (`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate`) semua proses di pohon proses app, termasuk `msedgewebview2.exe` atau helper Electron, dan `node.exe` Host. Lima sampel tiap detik setelah skenario selesai dan koneksi DevTools ditutup; per peluncuran dipakai median. Per jenis proses dicatat juga |
| Putusan | Lima peluncuran per skenario, tiap peluncuran baru; satu peluncuran pemanasan di awal tidak dicatat. `Compare-Desktop.ps1` memakai median dan menganggap variasi antar-run sebagai rentang nilai per run, diambil yang lebih besar dari kedua build |
| Perilaku | Sebelum mengukur, `-Setup` membuka tiap sesi fixture di kedua build. Jalur fungsional Tauri diuji smoke CI (`scripts/smoke.ps1`) |

Tidak diukur: start dingin setelah reboot dijalankan terpisah (`-Cold`), dan macOS dicatat terpisah bila ada Mac.

## Langkah

Semua perintah dijalankan dengan PowerShell 7 dari folder hasil ekstrak artifact `ttoken-code-tauri-prototype-windows-x64` (berisi `ttoken-code-desktop.exe`, folder `measure`, dan folder `scripts`).

1. Pasang installer Electron dari run CI yang sama (`ttoken-code-windows-x64-unsigned`). Tutup aplikasi lain yang berat.
2. Siapkan home ukur sekali. Skrip mengekstrak project `dsh` dari `app.asar` instalasi Electron ke folder kerja (sekali, beberapa menit), membuat sesi fixture, lalu membuka TTOken Code dengan home ukur. Isi API key TTOken Gateway di layar sambutan, tunggu jendela utama tampil, lalu tekan Enter di terminal.

   ```powershell
   pwsh -File measure/Measure-Desktop.ps1 -Setup
   ```

3. Ukur kedua build. Tiap perintah memakan sekitar 25 menit; layar jangan dikunci. Dengan `-CompileCache`, skrip berhenti bila compile cache Node masih kosong setelah pemanasan.

   ```powershell
   pwsh -File measure/Measure-Desktop.ps1 -Build Electron
   pwsh -File measure/Measure-Desktop.ps1 -Build Tauri
   pwsh -File measure/Measure-Desktop.ps1 -Build Tauri -CompileCache
   ```

4. Bandingkan. Path `result.json` dicetak di akhir tiap pengukuran.

   ```powershell
   pwsh -File measure/Compare-Desktop.ps1 -Electron <result.json Electron> -Tauri <result.json Tauri> -OutputPath k1.md
   ```

5. Start dingin: reboot, jalankan `-Build Electron -Cold`; reboot lagi, jalankan `-Build Tauri -Cold`.

Hasil tiap pengukuran ada di `%LOCALAPPDATA%\ttoken-measure\results\<build>-<waktu>\`: `result.json` (semua sampel), `summary.md`, dan timeline shell Tauri per peluncuran.

## File

| File | Fungsi |
| --- | --- |
| `Measure-Desktop.ps1` | Setup, peluncuran, skenario, dan hasil |
| `Compare-Desktop.ps1` | Tabel K1 dari dua hasil |
| `DesktopProcess.psm1` | Pohon proses, memori, deteksi jendela, screenshot |
| `Cdp.psm1` | Klien DevTools protocol minimal |
| `Scenario.psm1` | Langkah S2 dan S3 |
| `page.js` | Pembantu di halaman: kesiapan composer, waktu ganti sesi, muat riwayat, gulir |
| `seed-fixture.mjs` | Sesi sintetis S2 dan S3, ditulis lewat persistence JSONL bawaan |
| `../scripts/extract-payload.mjs` | Project `dsh` dari `app.asar` instalasi Electron sebagai berkas biasa, untuk prototipe Tauri dan pembuat fixture |
