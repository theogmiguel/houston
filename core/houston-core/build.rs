#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(houston_vt)");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");

    if let Ok(output) = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
    {
        if output.status.success() {
            let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !sha.is_empty() {
                println!("cargo:rustc-env=HOUSTON_BUILD_COMMIT={sha}");
            }
        }
    }

    build_ghostty_vt();
}

/// Deliberately not a TOML parse: the same three lines have to work in `bash`
/// and in `node`, so `ghostty-vt.lock` has no syntax beyond `key = "value"`.
fn read_lock(path: &Path) -> HashMap<String, String> {
    let text =
        fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let mut out = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        out.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
    }
    out
}

fn lock_get<'a>(lock: &'a HashMap<String, String>, key: &str, path: &Path) -> &'a str {
    lock.get(key).map(String::as_str).unwrap_or_else(|| {
        panic!(
            "{} is missing the key {key:?}; the emulator build cannot proceed without it",
            path.display()
        )
    })
}

fn cache_dir(out_dir: &Path) -> PathBuf {
    let target = out_dir.ancestors().nth(4).unwrap_or(out_dir);
    target.join("ghostty-vt")
}

fn build_ghostty_vt() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let lock_path = manifest.join("ghostty-vt.lock");
    let shim = manifest.join("ghostty-vt").join("houston_snapshot.zig");
    let patch = manifest
        .join("ghostty-patches")
        .join("0001-houston-snapshot-exports.patch");
    println!("cargo:rerun-if-changed={}", lock_path.display());
    println!("cargo:rerun-if-changed={}", shim.display());
    println!("cargo:rerun-if-changed={}", patch.display());
    println!("cargo:rerun-if-env-changed=HOUSTON_GHOSTTY_VT_SRC");
    println!("cargo:rerun-if-env-changed=HOUSTON_ZIG");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        println!("cargo:warning=libghostty-vt is not built for Windows; snapshot attach will be refused by name and byte replay stays on");
        return;
    }

    let lock = read_lock(&lock_path);
    let revision = lock_get(&lock, "revision", &lock_path);
    let version_string = lock_get(&lock, "lib_version_string", &lock_path);
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let cache = cache_dir(&out_dir);
    fs::create_dir_all(&cache).unwrap_or_else(|e| panic!("creating {}: {e}", cache.display()));

    let src = match std::env::var("HOUSTON_GHOSTTY_VT_SRC") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => fetch_source(&cache, &lock, &lock_path, revision),
    };
    apply_shim(&src, &shim, &patch);

    let zig = zig_binary(&cache, &lock, &lock_path);
    let prefix = cache.join(format!("build-{revision}"));
    let lib = prefix.join("lib").join("libghostty-vt.a");
    {
        // The extracted dependency lives inside Houston's worktree. Stop Git at
        // its cache boundary so a Houston release tag is not read as Ghostty's.
        run(
            Command::new(&zig)
                .current_dir(&src)
                .env("GIT_CEILING_DIRECTORIES", &cache)
                .arg("build")
                .arg("-Demit-lib-vt")
                .arg("-Doptimize=ReleaseFast")
                .arg(format!("-Dlib-version-string={version_string}"))
                .arg("-p")
                .arg(&prefix),
            "zig build -Demit-lib-vt",
        );
    }
    assert!(
        lib.exists(),
        "zig build finished but {} does not exist",
        lib.display()
    );

    println!(
        "cargo:rustc-link-search=native={}",
        prefix.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    // The library links SIMD helpers written in C++; Zig vendors its own libc++,
    // but the final link is rustc's, so the C++ runtime must be named here.
    println!("cargo:rustc-link-lib=dylib=stdc++");
    println!("cargo:rustc-cfg=houston_vt");
    println!("cargo:rustc-env=HOUSTON_GHOSTTY_VT_REVISION={revision}");
}

fn fetch_source(
    cache: &Path,
    lock: &HashMap<String, String>,
    lock_path: &Path,
    revision: &str,
) -> PathBuf {
    let dir = cache.join(format!("src-{revision}"));
    let stamp = dir.join(".houston-extracted");
    if stamp.exists() {
        return dir;
    }

    let url = lock_get(lock, "source_url", lock_path);
    let want = lock_get(lock, "source_sha256", lock_path);
    let tarball = cache.join(format!("ghostty-{revision}.tar.gz"));
    if !tarball.exists() {
        run(
            Command::new("curl")
                .args(["-sSL", "--fail", "-o"])
                .arg(&tarball)
                .arg(url),
            "curl (libghostty-vt source)",
        );
    }
    let got = sha256_file(&tarball);
    assert_eq!(
        got,
        want,
        "libghostty-vt source checksum mismatch for {url}\n  expected {want}\n  got      {got}\n\
         The pin in {} is what this build trusts. Point HOUSTON_GHOSTTY_VT_SRC at an \
         already-extracted tree of revision {revision} to bypass the fetch, or update the pin \
         deliberately.",
        lock_path.display()
    );

    let staging = cache.join(format!("src-{revision}.tmp"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).unwrap_or_else(|e| panic!("creating {}: {e}", staging.display()));
    run(
        Command::new("tar")
            .arg("-xzf")
            .arg(&tarball)
            .arg("--strip-components=1")
            .arg("-C")
            .arg(&staging),
        "tar (libghostty-vt source)",
    );
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&staging, &dir)
        .unwrap_or_else(|e| panic!("renaming {} -> {}: {e}", staging.display(), dir.display()));
    fs::write(&stamp, revision).unwrap_or_else(|e| panic!("writing {}: {e}", stamp.display()));
    dir
}

/// `patch -F 0`, not `git apply`: the extracted tree usually sits under
/// `core/target/` inside Houston's own work tree, where `git apply` resolves
/// paths against the wrong root — and `-F 0` makes an upstream move fail loudly.
fn apply_shim(src: &Path, shim: &Path, patch: &Path) {
    let dest = src
        .join("src")
        .join("terminal")
        .join("c")
        .join("houston_snapshot.zig");
    fs::copy(shim, &dest)
        .unwrap_or_else(|e| panic!("copying {} -> {}: {e}", shim.display(), dest.display()));

    let stamp = src.join(".houston-patched");
    if stamp.exists() {
        return;
    }
    run(
        Command::new("patch")
            .arg("-p1")
            .arg("-F")
            .arg("0")
            .arg("--no-backup-if-mismatch")
            .arg("-d")
            .arg(src)
            .arg("-i")
            .arg(patch),
        "patch (houston snapshot exports)",
    );
    assert!(
        fs::read_to_string(src.join("src").join("lib_vt.zig"))
            .map(|s| s.contains("houston_vt_snapshot_encode"))
            .unwrap_or(false),
        "the snapshot patch reported success but {} does not export \
         houston_vt_snapshot_encode",
        src.join("src").join("lib_vt.zig").display()
    );
    fs::write(&stamp, "1").unwrap_or_else(|e| panic!("writing {}: {e}", stamp.display()));
}

/// The pinned Zig, fetched into the build cache. Never taken from `PATH`
/// unless `HOUSTON_ZIG` names it: a build that silently used whatever Zig was
/// installed would produce an artifact this repo cannot reproduce.
fn zig_binary(cache: &Path, lock: &HashMap<String, String>, lock_path: &Path) -> PathBuf {
    if let Ok(zig) = std::env::var("HOUSTON_ZIG") {
        if !zig.is_empty() {
            return PathBuf::from(zig);
        }
    }
    let version = lock_get(lock, "zig_version", lock_path);
    let prefix = lock_get(lock, "zig_url_prefix", lock_path);
    let slug = zig_slug();
    let key = format!("zig_sha256_{slug}");
    let want = lock_get(lock, &key, lock_path);

    let dir = cache.join(format!("zig-{slug}-{version}"));
    let bin = dir.join("zig");
    if bin.exists() {
        return bin;
    }

    let name = format!("zig-{slug}-{version}.tar.xz");
    let archive = cache.join(&name);
    if !archive.exists() {
        run(
            Command::new("curl")
                .args(["-sSL", "--fail", "-o"])
                .arg(&archive)
                .arg(format!("{prefix}{slug}-{version}.tar.xz")),
            "curl (zig toolchain)",
        );
    }
    let got = sha256_file(&archive);
    assert_eq!(
        got, want,
        "zig {version} checksum mismatch for {slug}\n  expected {want}\n  got      {got}"
    );
    let staging = cache.join(format!("{slug}-{version}.tmp"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).unwrap_or_else(|e| panic!("creating {}: {e}", staging.display()));
    run(
        Command::new("tar")
            .arg("-xJf")
            .arg(&archive)
            .arg("--strip-components=1")
            .arg("-C")
            .arg(&staging),
        "tar (zig toolchain)",
    );
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&staging, &dir)
        .unwrap_or_else(|e| panic!("renaming {} -> {}: {e}", staging.display(), dir.display()));
    bin
}

fn zig_slug() -> String {
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let os = match os.as_str() {
        "macos" => "macos",
        "linux" => "linux",
        other => panic!("no pinned Zig for target_os {other:?}; extend ghostty-vt.lock first"),
    };
    format!("{arch}-{os}")
}

fn sha256_file(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("{:x}", hasher.finalize())
}

fn run(cmd: &mut Command, what: &str) {
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("{what} could not be started: {e} (cmd: {cmd:?})"));
    assert!(
        status.success(),
        "{what} failed with {status} (cmd: {cmd:?})"
    );
}
