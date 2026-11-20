# TTOken Code Desktop di Tauri

Shell Rust (Tauri 2.12) yang menggantikan proses induk Electron. Host TypeScript dan UI React tidak berubah: shell menjalankan Host di Node bawaan dan menyajikan Web client yang sama. Rencana lengkapnya di [`ttoken/docs/PRD-TAURI.md`](../docs/PRD-TAURI.md); folder ini sekarang berisi prototipe Fase 0.

## Cara kerja

| Bagian | Isi | Keputusan PRD |
| --- | --- | --- |
| Supervisor Host (`src/host/`) | Menjalankan `dsh-desktop-host` dengan Node dari runtime bawaan (`--expose-internals`), lewat socket lokal privat: Unix socket di folder 0700, atau named pipe satu instance. Koneksi diterima hanya dari PID Host yang dijalankan shell, sebelum secret dikirim. Pesannya sama dengan Node IPC Electron: `starting`, `desktop-auth`, `ready`, `shutdown`, `shutdown-complete` | D2, D3 |
| Kanal di sisi Host (`host/shell-channel.mjs`) | Dimuat dengan `node --import`; memberi `process.send`, `process.connected`, `process.disconnect`, dan event `message` serta `disconnect` di atas socket, satu JSON per baris | D3 |
| Profil (`host/prepare-profile.mjs`) | Bila profil belum ada, dibuat dengan `initProfile` milik payload, seperti `DesktopProjectManager` di Electron | |
| Protocol `ttoken-app` (`src/protocol.rs`) | Berkas Web client dari payload; permintaan lain diteruskan ke Host dengan cookie startup. Di Windows asalnya `http://ttoken-app.localhost` | D4 |
| Relay WebSocket (`src/socket.rs`) | Halaman meminta tiket sekali pakai ke shell, lalu membuka WebSocket ke relay di 127.0.0.1. Relay menerima handshake hanya dari asal aplikasi dengan tiket yang sah, lalu menulis ulang handshake seperti `webRequest` Electron (asal Host, cookie, `sec-fetch-site: same-origin`) | D5 |
| Jembatan (`src/bridge.js`) | Init script: `dshDesktopBoot`, dan accessor `__DSH_TRANSPORT__` yang memasang `createWebSocket` bertiket. WebView2 menjalankan init script di semua frame, jadi skrip ini berhenti sendiri di iframe; global IPC milik Tauri (`__TAURI_INTERNALS__`) tetap sampai ke iframe di Windows, tetapi capability tanpa `remote` menolak command dari asal lain | D5, D6 |
| Izin (`capabilities/main.json`) | Command shell hanya untuk jendela `main`, tanpa `remote` | D6 |
| Navigasi (`src/lib.rs`) | WebView2 hanya menanyakan navigasi frame utama, jadi di Windows hanya asal aplikasi yang lolos. WKWebView dan WebKitGTK menanyakan semua frame, jadi di sana isi iframe (http, https, blob, data) lolos, dan frame utama yang keluar dari asal aplikasi dikembalikan | D4 |
| Timeline (`src/timeline.rs`) | Kejadian start bertanda waktu, satu JSON per baris, untuk pengukuran | |

Di Fase 0 shell menjalankan payload build Electron, jadi kedua build diukur dengan Host dan Web client yang sama. Build Electron menyimpan project `dsh` di dalam `app.asar` dan hanya mengeluarkan kode native ke `app.asar.unpacked`. Electron membaca arsip itu dengan sendirinya, Node biasa tidak, jadi `scripts/extract-payload.mjs` menulis project itu sebagai berkas biasa ke folder payload (`dsh`, dan `runtime` yang ditautkan ke runtime build Electron). Payload dicari dari `--payload <folder>`, lalu `TTOKEN_DESKTOP_PAYLOAD`, lalu folder executable.

## Isi folder

| Path | Fungsi |
| --- | --- |
| `src/` | Shell Rust |
| `host/` | Modul yang dijalankan Node bawaan: kanal socket dan pembuat profil |
| `measure/` | Skrip ukur Fase 0 untuk Windows 11 (lihat [`measure/README.md`](measure/README.md)) |
| `scripts/extract-payload.mjs` | Tulis project `dsh` dari `app.asar` build Electron sebagai berkas biasa, untuk Node biasa |
| `scripts/addon-smoke.mjs` | Cek addon native di Node biasa |
| `scripts/smoke.ps1` | Buka prototipe sampai composer tampil, screenshot, lalu tutup (dipakai CI) |
| `scripts/check-parity.mjs` | Gagal bila upstream menambah kanal `DESKTOP_IPC` atau global preload yang belum ada di `PARITY.md` |
| `PARITY.md` | Status paritas dengan shell Electron |
| `docs/fase-0-hasil.md` | Hasil Fase 0 dan rekomendasi gerbang |

## Build dan jalankan

Butuh Rust stable. Windows juga butuh Visual C++ Build Tools; WebView2 sudah ada di Windows 10 (April 2018 ke atas) dan Windows 11. macOS butuh Xcode Command Line Tools. Untuk pengembangan di Linux butuh `libwebkit2gtk-4.1-dev`.

```sh
cd ttoken/desktop-tauri
cargo build --release
"<folder resources>/runtime/primary-runtime/dependencies/node/bin/node" scripts/extract-payload.mjs "<folder resources build Electron>" ~/ttoken-payload
./target/release/ttoken-code-desktop --payload ~/ttoken-payload
```

Workflow `.github/workflows/ttoken-desktop-tauri.yml` membangun prototipe untuk Windows x64 dan macOS Apple silicon pada setiap push ke `ttoken/desktop-tauri`, mengekstrak payload build Electron dari commit yang sama, memeriksa addon native, dan membuka prototipe sampai composer tampil. Artifact `ttoken-code-tauri-prototype-windows-x64` berisi exe, skrip ukur, dan `scripts/extract-payload.mjs`.

Variabel lingkungan:

| Variabel | Fungsi |
| --- | --- |
| `TTOKEN_DESKTOP_PAYLOAD` | Folder payload bila `--payload` tidak diberikan |
| `DSH_HOME` | Home Harness; bawaannya `~/.ttoken-code`, sama dengan build Electron |
| `TTOKEN_DESKTOP_TIMELINE` | File timeline; bawaannya `timeline.jsonl` di folder log app |
| `TTOKEN_DESKTOP_MARK_COMPOSER` | `1`: halaman mencatat `composer-shown` dan `composer-ready` ke timeline (uji smoke) |
| `TTOKEN_DESKTOP_DEBUG_PORT` | Windows: port DevTools WebView2, dipakai skrip ukur |

Log ada di `%LOCALAPPDATA%\dev.ttoken.code\logs` (Windows) atau `~/Library/Logs/dev.ttoken.code` (macOS): `timeline.jsonl` dan `host.log`.

## Pemeriksaan

Sebelum push: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, dan `cargo test` di folder ini, plus `node ttoken/desktop-tauri/scripts/check-parity.mjs` dari akar repo. Kode Windows (named pipe) bisa diperiksa dari Linux dengan `cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings`.

## Batas Fase 0

Hanya jalur boot yang ada. Seperti Electron, jendela utama tersembunyi sampai halaman boot dan Host menjawab (paling lambat 30 detik, atau langsung saat halaman galat start dimuat). Belum ada tray, satu instance, layar sambutan, bilah judul Windows kustom, API `dshDesktop`, installer, atau updater; rinciannya di `PARITY.md`. Profil yang sudah ada dipakai apa adanya. Migrasi `pnpm-workspace.yaml` lama dan validasi `desktop-runtime.json` di `applyRelease` Electron belum dijalankan.
