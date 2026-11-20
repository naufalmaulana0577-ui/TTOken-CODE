//! Generate Tauri's context and the permissions of the shell commands.

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "desktop_boot",
            "desktop_boot_failed",
            "desktop_ws_ticket",
            "desktop_mark",
        ])),
    )
    .expect("tauri-build failed");
}
