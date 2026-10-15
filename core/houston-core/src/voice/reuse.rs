use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use houston_protocol::VoiceExternalModel;
use sha2::{Digest, Sha256};

use super::models::{self, ModelSpec};

// Bound explicit scans even when a cache contains many unrelated model snapshots.
const MAX_ENTRIES: usize = 4096;
// Several alternatives per catalogue model fit in a bounded settings reply.
const MAX_RESULTS: usize = 64;
const MAX_DEPTH: usize = 6;
const MAX_HASH_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const SCAN_TIME: Duration = Duration::from_secs(30);

pub fn reference_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.link.json"))
}

pub fn linked_path(dir: &Path, id: &str) -> Option<PathBuf> {
    models::find(id)?;
    let mut bytes = Vec::new();
    std::fs::File::open(reference_path(dir, id))
        .ok()?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice::<PathBuf>(&bytes).ok()
}

pub fn resolve_path(dir: &Path, id: &str) -> Option<PathBuf> {
    models::find(id)?;
    let owned = models::final_model_path(dir, id);
    if owned.is_file() {
        Some(owned)
    } else {
        linked_path(dir, id)
    }
}

pub fn verify_file(path: &Path, spec: &ModelSpec) -> Result<()> {
    if !std::fs::metadata(path)?.is_file() {
        bail!("model {} is not a regular file", path.display());
    }
    let mut file =
        std::fs::File::open(path).with_context(|| format!("reading model {}", path.display()))?;
    let size = file.metadata()?.len();
    if size != spec.size_bytes {
        bail!(
            "model {:?} at {} has {size} bytes; expected {} bytes",
            spec.id,
            path.display(),
            spec.size_bytes
        );
    }
    let hash = hash_reader(&mut file, spec.size_bytes, Instant::now() + SCAN_TIME)?;
    if hash != spec.sha256 {
        bail!(
            "model {:?} at {} failed SHA-256 verification: expected {}, got {hash}",
            spec.id,
            path.display(),
            spec.sha256
        );
    }
    Ok(())
}

fn hash_reader(reader: &mut impl Read, limit: u64, deadline: Instant) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        if Instant::now() >= deadline {
            bail!("model scan exceeded the 30-second time limit");
        }
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        read += n as u64;
        if read > limit {
            bail!("model hash exceeded the {limit}-byte limit (read {read})");
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The caller supplies a trusted catalogue entry; filenames never establish identity.
pub fn reuse_file(dir: &Path, path: &Path, spec: &ModelSpec, copy: bool) -> Result<()> {
    let path = std::fs::canonicalize(path)?;
    verify_file(&path, spec)?;
    std::fs::create_dir_all(dir)?;
    let own_dir = std::fs::canonicalize(dir)?;
    if path.starts_with(&own_dir) {
        bail!("model {} already belongs to this channel", path.display());
    }
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    if copy {
        let mut source = std::fs::File::open(&path)?;
        // Verify the bytes copied, too: an external owner may replace a scanned file.
        let mut hasher = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        let deadline = Instant::now() + SCAN_TIME;
        loop {
            if Instant::now() >= deadline {
                bail!("model copy exceeded the 30-second time limit");
            }
            let n = source.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            if bytes > spec.size_bytes {
                bail!("model {:?} changed size while copying", spec.id);
            }
            hasher.update(&buffer[..n]);
            temp.write_all(&buffer[..n])?;
        }
        if bytes != spec.size_bytes || format!("{:x}", hasher.finalize()) != spec.sha256 {
            bail!(
                "model {:?} changed while copying; SHA-256 verification failed",
                spec.id
            );
        }
        temp.flush()?;
        temp.persist(models::final_model_path(dir, spec.id))?;
        remove_reference(dir, spec.id)?;
    } else {
        if models::final_model_path(dir, spec.id).exists() {
            bail!(
                "model {:?} is already installed; delete it before linking",
                spec.id
            );
        }
        serde_json::to_writer(&mut temp, &path)?;
        temp.flush()?;
        temp.persist(reference_path(dir, spec.id))?;
    }
    Ok(())
}

fn remove_reference(dir: &Path, id: &str) -> Result<()> {
    match std::fs::remove_file(reference_path(dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn scan_roots(home: &Path, current: &Path) -> Vec<(PathBuf, String)> {
    discover_roots(home, current, Instant::now() + SCAN_TIME).0
}

fn discover_roots(
    home: &Path,
    current: &Path,
    deadline: Instant,
) -> (Vec<(PathBuf, String)>, usize, bool) {
    let mut roots = vec![
        (
            home.join(".local/share/com.pais.handy/models"),
            "Handy".into(),
        ),
        (
            home.join(".cache/huggingface/hub"),
            "Hugging Face cache".into(),
        ),
    ];
    #[cfg(windows)]
    #[allow(clippy::disallowed_methods)] // env-ratchet: reads the process environment directly
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(key) {
            roots.push((
                PathBuf::from(base).join("com.pais.handy/models"),
                "Handy".into(),
            ));
        }
    }
    // Only immediate, validated channel directories; never recurse through user state.
    let mut visited = 0;
    let mut limited = false;
    if let Ok(entries) = std::fs::read_dir(home) {
        for entry in entries {
            if visited >= MAX_ENTRIES || Instant::now() >= deadline {
                limited = true;
                break;
            }
            visited += 1;
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != ".houston"
                && !name
                    .strip_prefix(".houston-")
                    .is_some_and(|s| crate::paths::validate_channel(s).is_ok())
            {
                continue;
            }
            let root = entry.path().join("models");
            if std::fs::canonicalize(&root).ok() != std::fs::canonicalize(current).ok() {
                roots.push((root, format!("Houston channel {name}")));
            }
        }
    }
    (roots, visited, limited)
}

pub fn scan(roots: &[(PathBuf, String)], catalog: &[ModelSpec]) -> (Vec<VoiceExternalModel>, bool) {
    scan_until(roots, catalog, 0, Instant::now() + SCAN_TIME)
}

pub fn scan_home(
    home: &Path,
    current: &Path,
    catalog: &[ModelSpec],
) -> (Vec<VoiceExternalModel>, bool) {
    let deadline = Instant::now() + SCAN_TIME;
    let (roots, entries, limited) = discover_roots(home, current, deadline);
    let (files, scan_limited) = scan_until(&roots, catalog, entries, deadline);
    (files, limited || scan_limited)
}

fn scan_until(
    roots: &[(PathBuf, String)],
    catalog: &[ModelSpec],
    mut entries: usize,
    deadline: Instant,
) -> (Vec<VoiceExternalModel>, bool) {
    let mut pending: Vec<_> = roots
        .iter()
        .map(|(p, s)| (p.clone(), s.clone(), 0usize))
        .collect();
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    let mut hashed = 0u64;
    let mut limited = false;
    while let Some((dir, source, depth)) = pending.pop() {
        let Ok(children) = std::fs::read_dir(dir) else {
            continue;
        };
        for child in children.flatten() {
            entries += 1;
            if entries > MAX_ENTRIES || Instant::now() >= deadline {
                return (found, true);
            }
            let Ok(kind) = child.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    pending.push((child.path(), source.clone(), depth + 1));
                } else {
                    limited = true;
                }
                continue;
            }
            let Ok(path) = std::fs::canonicalize(child.path()) else {
                continue;
            };
            if seen.contains(&path) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let candidates: Vec<_> = catalog
                .iter()
                .filter(|s| s.size_bytes == meta.len())
                .collect();
            let model_id = if candidates.is_empty() {
                None
            } else {
                if hashed.saturating_add(meta.len()) > MAX_HASH_BYTES {
                    limited = true;
                    continue;
                }
                hashed += meta.len();
                let Ok(mut file) = std::fs::File::open(&path) else {
                    continue;
                };
                let Ok(hash) = hash_reader(&mut file, meta.len(), deadline) else {
                    limited = true;
                    continue;
                };
                candidates
                    .iter()
                    .find(|s| s.sha256 == hash)
                    .map(|s| s.id.to_string())
            };
            let unsupported = model_id.is_none()
                && child
                    .path()
                    .to_string_lossy()
                    .to_lowercase()
                    .contains("parakeet");
            if model_id.is_some() || unsupported {
                seen.insert(path.clone());
                if found.len() >= MAX_RESULTS {
                    return (found, true);
                }
                found.push(VoiceExternalModel {
                    path: path.to_string_lossy().into_owned(),
                    source: source.clone(),
                    model_id,
                    unsupported_reason: unsupported
                        .then(|| "Parakeet is not supported by the local Whisper engine".into()),
                });
            }
        }
    }
    (found, limited)
}

pub fn memory_available_bytes() -> Option<u64> {
    memory_field("MemAvailable:")
}

fn memory_field(key: &str) -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    text.lines()
        .find_map(|line| {
            line.strip_prefix(key)?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
        .map(|kb| kb * 1024)
}

pub fn guidance(spec: &ModelSpec) -> String {
    let cores = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|text| {
            let pairs: HashSet<_> = text
                .split("\n\n")
                .filter_map(|cpu| {
                    let field = |key: &str| {
                        cpu.lines().find_map(|l| {
                            l.split_once(':')
                                .filter(|(k, _)| k.trim() == key)
                                .map(|(_, v)| v.trim().to_owned())
                        })
                    };
                    Some((field("physical id")?, field("core id")?))
                })
                .collect();
            (!pairs.is_empty()).then_some(pairs.len())
        });
    let total = memory_field("MemTotal:");
    let hardware = match (cores, total) {
        (Some(c), Some(m)) => format!(
            "{c} physical cores, {:.1} GiB RAM. ",
            m as f64 / 1073741824.0
        ),
        _ => "Hardware capacity unavailable. ".to_string(),
    };
    let slow = spec.memory_gib >= 3
        && (cores.is_some_and(|c| c < 6) || total.is_some_and(|m| m < 8 * 1073741824));
    format!("{hardware}Allow about {} GiB working headroom. {}Guidance only; builds and Auto-detect can increase latency.", spec.memory_gib, if slow { "This model may be slow on this machine. " } else { "" })
}
