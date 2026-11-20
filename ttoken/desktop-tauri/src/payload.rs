//! Location of the Harness payload: the Host project with the Web client, and the bundled runtime.
//!
//! A payload root holds the project as files at `dsh` and the runtime at `runtime`. A packaged Electron build keeps
//! the project inside `app.asar`, which only Electron can read, so in Phase 0 `scripts/extract-payload.mjs` writes
//! the project of an installed Electron build out as files and links its runtime. Both shells then run the same Host
//! and Web client.

use std::path::{Path, PathBuf};

/// Environment variable naming a payload root explicitly.
pub const PAYLOAD_ENV: &str = "TTOKEN_DESKTOP_PAYLOAD";

/// Every path the shell reads from one payload root.
#[derive(Debug, Clone)]
pub struct Payload {
    /// Directory the payload was resolved from.
    pub root: PathBuf,
    /// Project directory whose `node_modules` holds the Harness packages; the Host's runtime directory.
    pub project: PathBuf,
    /// Bundled dependency payload the Host exposes to its profile as `DSH_PRIMARY_RUNTIME`.
    pub primary_runtime: PathBuf,
    /// Node executable from the bundled runtime.
    pub node: PathBuf,
    /// pnpm entry the Host uses for plugin package operations.
    pub pnpm: PathBuf,
    /// Directory of the `node` launchers that package scripts find on `PATH`.
    pub node_bin: PathBuf,
    /// Desktop Host entry module.
    pub host_entry: PathBuf,
    /// Built Web client served at the application origin.
    pub web_dist: PathBuf,
    /// Version of the Desktop Host package, reported to the Host as the client version.
    pub host_version: String,
}

impl Payload {
    /// Resolve and check the payload under `root`.
    ///
    /// # Errors
    ///
    /// Returns a message naming the first required file or directory that is missing.
    pub fn from_root(root: &Path) -> Result<Self, String> {
        let project = root.join("dsh");
        if !project.is_dir() {
            if root.join("app.asar").is_file() {
                return Err(format!(
                    "{}: the dsh project is packed in app.asar, which plain Node cannot read; \
                     write it out with scripts/extract-payload.mjs and pass that directory",
                    root.display()
                ));
            }
            return Err(format!("{}: no dsh project directory", root.display()));
        }
        let runtime = root.join("runtime");
        let primary_runtime = runtime.join("primary-runtime");
        let node = primary_runtime
            .join("dependencies")
            .join("node")
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let pnpm = primary_runtime
            .join("dependencies")
            .join("pnpm")
            .join("bin")
            .join("pnpm.mjs");
        let packages = project.join("node_modules").join("@deepseek-ai");
        let host_package = packages.join("dsh-desktop-host");
        let host_entry = host_package.join("lib").join("index.js");
        let web_dist = packages.join("dsh-web-frontend").join("dist");
        for required in [&node, &pnpm, &host_entry, &web_dist.join("index.html")] {
            if !required.is_file() {
                return Err(format!("{}: missing {}", root.display(), required.display()));
            }
        }
        let manifest = std::fs::read_to_string(host_package.join("package.json"))
            .map_err(|error| format!("{}: cannot read the Host manifest: {error}", root.display()))?;
        let host_version = serde_json::from_str::<serde_json::Value>(&manifest)
            .ok()
            .and_then(|value| value.get("version")?.as_str().map(str::to_owned))
            .ok_or_else(|| format!("{}: the Host manifest has no version", root.display()))?;
        Ok(Self {
            root: root.to_path_buf(),
            project,
            primary_runtime,
            node,
            pnpm,
            node_bin: runtime.join("bin"),
            host_entry,
            web_dist,
            host_version,
        })
    }
}

/// Find the payload: the explicit root when given, otherwise the first valid default location.
///
/// Defaults, in order: `TTOKEN_DESKTOP_PAYLOAD`, then the directory of this executable.
///
/// # Errors
///
/// Returns every rejected candidate with its reason.
pub fn locate(explicit: Option<PathBuf>) -> Result<Payload, String> {
    let candidates = match explicit {
        Some(root) => vec![root],
        None => default_roots(),
    };
    let mut rejected = Vec::new();
    for root in candidates {
        // The Host runs in the profile directory, so every payload path it receives must be absolute. Not
        // canonicalized: Node mishandles the `\\?\` form that `canonicalize` returns on Windows.
        let root = std::path::absolute(&root).unwrap_or(root);
        match Payload::from_root(&root) {
            Ok(payload) => return Ok(payload),
            Err(reason) => rejected.push(reason),
        }
    }
    Err(format!("no Harness payload found:\n  {}", rejected.join("\n  ")))
}

fn default_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os(PAYLOAD_ENV).filter(|value| !value.is_empty()) {
        roots.push(PathBuf::from(root));
    }
    if let Some(directory) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        roots.push(directory);
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::Payload;
    use std::path::Path;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        std::fs::write(path, text).expect("write file");
    }

    #[test]
    fn rejects_a_project_packed_in_asar() {
        let root = std::env::temp_dir().join(format!("ttoken-payload-asar-{}", std::process::id()));
        write(&root.join("app.asar"), "");
        write(&root.join("app.asar.unpacked/dsh/node_modules/native/addon.node"), "");
        let error = Payload::from_root(&root).expect_err("packed project");
        assert!(error.contains("extract-payload.mjs"), "{error}");
        std::fs::remove_dir_all(root).expect("remove test payload");
    }

    #[test]
    fn resolves_an_extracted_payload() {
        let root = std::env::temp_dir().join(format!("ttoken-payload-{}", std::process::id()));
        let project = root.join("dsh");
        let packages = project.join("node_modules").join("@deepseek-ai");
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        write(
            &root.join("runtime/primary-runtime/dependencies/node/bin").join(node),
            "",
        );
        write(&root.join("runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"), "");
        write(&packages.join("dsh-desktop-host/lib/index.js"), "");
        write(
            &packages.join("dsh-desktop-host/package.json"),
            r#"{"version":"0.2.2-rc.5"}"#,
        );
        write(&packages.join("dsh-web-frontend/dist/index.html"), "<html></html>");
        let payload = Payload::from_root(&root).expect("payload");
        assert_eq!(payload.project, project);
        assert_eq!(payload.host_version, "0.2.2-rc.5");
        std::fs::remove_file(packages.join("dsh-web-frontend/dist/index.html")).expect("remove index");
        let missing = Payload::from_root(&root).expect_err("missing Web client");
        assert!(missing.contains("index.html"), "{missing}");
        std::fs::remove_dir_all(root).expect("remove test payload");
    }
}
