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
| Jembatan (`src/bridge.js`) | Init script di frame utama saja: `dshDesktopBoot`, dan accessor `__DSH_TRANSPORT__` yang memasang `createWebSocket` bertiket | D5, D6 |
| Izin (`capabilities/main.json`) | Command shell hanya untuk jendela `main`, tanpa `remote` | D6 |
| Timeline (`src/timeline.rs`) | Kejadian start bertanda waktu, satu JSON per baris, untuk pengukuran | |

Di Fase 0 shell menjalankan payload dari instalasi Electron (folder `resources`), jadi kedua build diukur dengan Host dan Web client yang sama. Payload dicari dari `--payload <folder>`, lalu `TTOKEN_DESKTOP_PAYLOAD`, folder executable, dan instalasi TTOken Code di `%LOCALAPPDATA%\Programs` atau `/Applications`.

## Isi folder

| Path | Fungsi |
| --- | --- |
| `src/` | Shell Rust |
| `host/` | Modul yang dijalankan Node bawaan: kanal socket dan pembuat profil |
| `measure/` | Skrip ukur Fase 0 untuk Windows 11 (lihat [`measure/README.md`](measure/README.md)) |
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
./target/release/ttoken-code-desktop --payload "<folder resources build Electron>"
```

Workflow `.github/workflows/ttoken-desktop-tauri.yml` membangun prototipe untuk Windows x64 dan macOS Apple silicon pada setiap push ke `ttoken/desktop-tauri`, memeriksa addon native, dan membuka prototipe dengan payload dari commit yang sama sampai composer tampil. Artifact `ttoken-code-tauri-prototype-windows-x64` berisi exe dan skrip ukur.

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

Hanya jalur boot yang ada. Belum ada tray, satu instance, layar sambutan, bilah judul Windows kustom, API `dshDesktop`, installer, atau updater; rinciannya di `PARITY.md`. Profil yang sudah ada dipakai apa adanya. Migrasi `pnpm-workspace.yaml` lama dan validasi `desktop-runtime.json` di `applyRelease` Electron belum dijalankan.
