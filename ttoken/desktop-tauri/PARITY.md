# Paritas shell Tauri dengan shell Electron

Daftar ini memetakan semua yang diberikan shell Electron (`apps/desktop`) ke shell Tauri: 10 global preload, 34 kanal `DESKTOP_IPC`, dan modul main process. Per 21 Nov 2026 yang selesai hanya jalur boot (Fase 0); sisanya terjadwal per fase PRD (`ttoken/docs/PRD-TAURI.md`).

`scripts/check-parity.mjs` dijalankan CI dan gagal bila upstream menambah kanal `DESKTOP_IPC` atau global preload yang belum ada di tabel di bawah.

Arti status:

| Status | Arti |
| --- | --- |
| selesai | Jalan di shell Tauri, dengan uji |
| fase N | Dijadwalkan di fase N PRD |
| web | Client memakai perilaku Web; keterbatasannya dicatat |
| ditunda | Menunggu layanan milik TTOken |
| dibuang | Tidak dipakai TTOken, tidak diport |

## Global preload

Tanpa sebuah global, client memakai perilaku Web, jadi global yang belum ada tidak merusak halaman.

| Global | Dipakai oleh | Status | Catatan |
| --- | --- | --- | --- |
| `dshDesktopBoot` | Web entry (`apps/web/src/main.ts`) | selesai | Command `desktop_boot` dan `desktop_boot_failed` (Fase 0) |
| `dshDesktop` | API produk: file, drag, keyboard, shortcut, update, browser samping | fase 2 | `browser` di Fase 3, `updates` di Fase 4 |
| `dshOnboarding` | Status API key dan onboarding di jendela utama | fase 1 | Bersama layar sambutan |
| `dshWelcome` | Layar sambutan | fase 1 | Halaman React yang sama |
| `__DSH_DIRECTORY_PICKER__` | Pemilih folder native | fase 2 | Sekarang dialog folder di halaman (perilaku Web) |
| `__DSH_HOST_PATHS__` | Path asli berkas yang di-drop atau dipilih | fase 2 | Bila WebView tidak memberi path: tetap perilaku Web |
| `__DSH_LOCALE__` | Bahasa antarmuka mengikuti shell | fase 2 | Sekarang bahasa dari WebView (`navigator.language`) |
| `dshUpdateDialog` | Dialog update | fase 4 | Diganti `tauri-plugin-updater` |
| `dshMandatoryUpdate` | Jendela update wajib | ditunda | Menunggu layanan kebijakan update TTOken |
| `dsh` | Platform view DeepSeek (akun tertanam) | dibuang | Platform view tidak dipakai TTOken |

Tambahan khusus Tauri (tidak ada di Electron): `__DSH_TRANSPORT__` dibuat accessor oleh init script supaya `createWebSocket` bertiket tetap terpasang (D5), dan command `desktop_ws_ticket` serta `desktop_mark` (penanda composer untuk uji smoke).

## Kanal DESKTOP_IPC

| Kanal | Fungsi | Status |
| --- | --- | --- |
| `boot` | Injeksi boot dan base URL stream untuk Web entry | selesai |
| `bootFailed` | Laporan gagal boot dari halaman | selesai |
| `enterWorkspace` | Fokus ke workspace setelah sambutan | fase 1 |
| `onboardingActive` | Status onboarding di jendela utama | fase 1 |
| `onboardingApiKey` | Cek API key untuk onboarding | fase 1 |
| `nativeThemeSet` | Tema native mengikuti pilihan di halaman | fase 1 |
| `windowFullscreen` | Status layar penuh ke halaman | fase 1 |
| `windowsAppearance` | Warna bilah judul Windows dari palet halaman | fase 1 |
| `windowsMenu` | Menu aplikasi dari bilah judul Windows kustom | fase 1 |
| `fileSave` | Dialog simpan berkas | fase 2 |
| `clipboardImageRead` | Baca gambar dari clipboard | fase 2 |
| `directoryPick` | Pemilih folder native | fase 2 |
| `fileDragPrepare` | Siapkan drag berkas ke luar app | fase 2 |
| `fileDragCancel` | Batalkan persiapan drag | fase 2 |
| `fileDragStart` | Mulai drag berkas ke Explorer atau Finder | fase 2 |
| `fileDragRelease` | Lepas berkas drag yang disiapkan | fase 2 |
| `deviceInfo` | Deskripsi mesin untuk kuesioner feedback | fase 2 |
| `localeBootstrap` | Bahasa awal antarmuka | fase 2 |
| `localeChanged` | Bahasa berubah di halaman | fase 2 |
| `shortcutsInput` | Chord yang dicegat shell sebelum halaman | fase 2 |
| `shortcutsCloseWindow` | Tutup jendela lewat shortcut | fase 2 |
| `shortcutsGet` | Baca `keybindings.json` | fase 2 |
| `shortcutsEdit` | Ubah shortcut | fase 2 |
| `shortcutsChanged` | Shortcut berubah | fase 2 |
| `shortcutsRecording` | Mode rekam shortcut | fase 2 |
| `browserAcquire` | Ambil browser samping (webview) | fase 3 |
| `browserRelease` | Lepas browser samping | fase 3 |
| `browserOpenRequested` | Buka URL di browser samping | fase 3 |
| `updatesChannelGet` | Kanal update | fase 4 |
| `updatesChannelSet` | Ganti kanal update | fase 4 |
| `updatesChannelChanged` | Kanal update berubah | fase 4 |
| `updatesStatus` | Status update | fase 4 |
| `updatesOpen` | Buka dialog update | fase 4 |
| `updatesPresentation` | Tampilan status update | fase 4 |

## Modul main process

| Area | File Electron | Rencana Tauri | Status |
| --- | --- | --- | --- |
| Host | `host-process.ts`, `parent-authentication.ts`, `node-environment.ts`, `paths.ts` | Supervisor Rust (`src/host/`): start Node bawaan, kanal socket privat dengan cek PID, `starting`, `desktop-auth`, `ready`, `shutdown` | selesai (Fase 0) |
| Host | `backend-controller.ts`, `fatal-recovery.ts`, `startup-error.ts`, `login-shell-environment.ts`, `owned-directory.ts`, `duration-env.ts` | Start ulang, dialog pemulihan, environment login shell di macOS | fase 1 |
| Halaman dan transport | `web-document.ts`, `client-metadata.ts`, `host-protocol.ts`, `ipc.ts` | Protocol `ttoken-app` (`src/protocol.rs`), relay WebSocket bertiket (`src/socket.rs`) | selesai (Fase 0) |
| Profil | `project-manager.ts` (`applyRelease`) | Profil baru dibuat dengan `initProfile` milik payload (`host/prepare-profile.mjs`). Belum: migrasi `pnpm-workspace.yaml` lama, validasi `desktop-runtime.json`, dan kunci profil | sebagian; sisanya fase 1 |
| Profil | `project-manager.ts` (`disableAllPlugins`) | Aksi "matikan plugin" di dialog pemulihan | fase 1 |
| Siklus app dan jendela | `main.ts`, `single-instance.ts`, `quit-confirmation.ts`, `background-notice.ts`, `tray.ts`, `windows-layout.ts`, `preload-windows.ts`, `preload-theme.ts`, `preload-platform.ts`, `preload-menu.ts` | Jendela, tray, tutup ke latar, satu instance, menu, bilah judul kustom | fase 1 |
| Sambutan | `welcome-window.ts`, `welcome-backend.ts`, `welcome-api.ts`, `preload-welcome.ts`, `account-backend.ts` | Halaman React yang sama lewat command | fase 1 |
| Bahasa | `locale.ts`, `locale-cache.ts` | String shell 8 bahasa dibangkitkan dari `locale.ts` | fase 1 |
| API produk | `file-actions.ts`, `file-drag.ts`, `file-drag-files.ts`, `directory-picker.ts`, `device-info.ts`, `keyboard.ts`, `keybindings.ts`, `settings-file.ts`, `settings.ts`, `microphone-permissions.ts`, `preload-app.ts` | Satu command per method | fase 2 |
| Diagnostik | `crash-report.ts` | Laporan crash ditulis shell sebelum dialog pemulihan. Port ke Rust bersama dialognya; tail konsol halaman diambil lewat init script | fase 1 |
| Diagnostik | `operation-journal.ts`, `operation-history.ts`, `operation-report.ts`, `operation-report-job.ts`, `operation-report-worker.ts` | Jurnal pesan `plugin-operation` dari Host, ditempel ke laporan crash. Shell Tauri sekarang menerima lalu mengabaikan pesan itu. Port jurnal ke Rust | fase 2 |
| Operasi paket | `runtime-tree.ts`, `core-package-set.ts` | Dipakai skrip packaging dan validasi saat start; tetap di skrip build Node | tidak berubah |
| Browser samping | `browser-guests.ts`, `preload-browser.ts` | Fallback iframe dulu (K3) | fase 3 |
| Paket payload | `scripts/electron-builder-config.mjs` (`asar`, `asarUnpack`), `scripts/windows-asar-unpack.mjs` | Electron mengemas project `dsh` ke `app.asar`, yang tidak bisa dibaca Node biasa. Fase 0 memakai `scripts/extract-payload.mjs`; installer Tauri mengirim `dsh` sebagai berkas biasa | fase 0 lewat ekstrak; installer fase 4 |
| Update | `update-*.ts`, `updates/electron-updater/*`, `preload-update-dialog.ts`, `release.ts` | `tauri-plugin-updater` | fase 4 |
| Update wajib | `mandatory-update-*.ts`, `preload-mandatory*.ts`, `policy-test-auth.ts` | Menunggu layanan kebijakan TTOken | ditunda |
| Dibuang | `platform-view.ts`, `platform-ipc.ts`, `preload-platform-account.ts`, `command-installation.ts`, `command-management.ts`, `command-manager-entry.ts` | Tidak diport | dibuang |

Hasil audit modul diagnostik dan operasi paket (Fase 0, langkah 8): tidak ada yang memakai API Electron; semuanya modul Node biasa. Yang berjalan di shell saat app hidup: `crash-report.ts` (saat gagal fatal), jurnal operasi (tiap pesan `plugin-operation`), dan `project-manager.ts` (tiap start). `runtime-tree.ts` dan `core-package-set.ts` terutama dipakai saat build; `runtime-tree.ts` juga dibaca saat start untuk versi bawaan di kebijakan update wajib.

## Penyimpanan browser

Halaman di Electron menyimpan data di localStorage asal `dsh-app://app`. WebView shell Tauri memakai asal lain (`http://ttoken-app.localhost` di Windows), jadi data ini tidak terbawa saat pindah. Hasil audit (Fase 0):

| Kunci | Isi | Penting saat pindah |
| --- | --- | --- |
| `dsh.conversation.<sessionId>` | Draf composer per sesi | ya |
| Agen papan Issues (`ttoken/forge/client/install.ts`) | Sesi agen yang dimulai dari papan, per repositori | ya |
| `dsh.sessions.current` | Sesi yang terakhir dibuka per workspace | sedang |
| `dsh.forge-viewed.v1.*`, antrean review | Berkas yang sudah dilihat di Code review | sedang |
| `dsh.plugin-manager.install-registry` | Registry pilihan di halaman Plugins | sedang |
| `dsh.workspace.view.v5`, `dsh.conversation.contentWidth`, `dsh.slot.manual-order.conversation.view.v1`, panel sidebar kanan, pin panel sesi | Tata letak | tidak |
| `dsh.trajectory.duration`, `dsh.trajectory.jsonStringWrapping`, preferensi pencarian berkas, `dsh.open-in-app.choice` | Preferensi tampilan | tidak |
| `dsh.schedule.recent-time-zones.v1`, binding tab jadwal | Preferensi jadwal | tidak |
| `dsh.voice-input.microphone`, `dsh.creation-recommendations.info-dismissed` | Preferensi kecil | tidak |
| Shortcut (`ui-shortcuts`) | Hanya perilaku Web; di desktop shortcut disimpan di `keybindings.json` | tidak |

Usul untuk Fase 4: installer Tauri menyalin kunci yang penting dari leveldb `Local Storage` Electron ke data WebView2 dengan asal baru, atau Host menyimpan draf dan sesi papan Issues. Sisanya dicatat di catatan rilis.
