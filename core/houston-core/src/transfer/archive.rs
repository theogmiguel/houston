//! The file: a gzip tar inside an age envelope encrypted to a passphrase (scrypt).
//! `manifest.json` is the first entry, so a summary needs no full unpack.

use super::manifest::{Manifest, FORMAT_VERSION, MANIFEST_ENTRY};
use super::refuse;
use anyhow::{bail, Context, Result};
use houston_protocol::TransferRefusalCode as Code;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};

/// The largest file export writes. The file is carried by hand; state past this size
/// (large untracked artefacts, long unpushed history) belongs in a git remote instead.
pub const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// Unpacking stops past this many bytes, so a crafted file cannot fill the disk.
pub const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// scrypt cost N = 2^18 (256 MiB, about a second on a laptop). Fixed rather than
/// calibrated, so a slower computer than the exporting one still opens the file.
const WORK_FACTOR: u8 = 18;
/// The highest cost import accepts: four times the export cost, which bounds the memory
/// a crafted file can demand.
const MAX_WORK_FACTOR: u8 = 20;
/// The largest manifest read: it lists paths and pane metadata, never file contents.
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;

pub enum Source {
    Bytes(Vec<u8>),
    File(PathBuf),
}

pub struct Entry {
    /// `/`-separated path inside the archive.
    pub path: String,
    pub source: Source,
}

impl Entry {
    fn size(&self) -> Result<u64> {
        Ok(match &self.source {
            Source::Bytes(bytes) => bytes.len() as u64,
            Source::File(path) => std::fs::metadata(path)
                .with_context(|| format!("reading the size of {}", path.display()))?
                .len(),
        })
    }

    fn label(&self) -> String {
        match &self.source {
            Source::Bytes(_) => self.path.clone(),
            Source::File(path) => path.display().to_string(),
        }
    }
}

#[derive(Debug)]
struct OverCap;

impl std::fmt::Display for OverCap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the file reached the {MAX_FILE_BYTES}-byte limit")
    }
}

impl std::error::Error for OverCap {}

struct Capped<W> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Capped<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.written + buf.len() as u64 > MAX_FILE_BYTES {
            return Err(std::io::Error::other(OverCap));
        }
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn is_over_cap(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .and_then(|io| io.get_ref())
            .is_some_and(|inner| inner.is::<OverCap>())
            || cause.is::<OverCap>()
    })
}

/// Writes the file to `dest` and returns its size. A file past `MAX_FILE_BYTES` is
/// refused with the largest entries named; `dest` is then left for the caller to remove.
pub fn write(dest: &Path, passphrase: &str, manifest: &Manifest, entries: &[Entry]) -> Result<u64> {
    match write_unchecked(dest, passphrase, manifest, entries) {
        Ok(size) => Ok(size),
        Err(error) if is_over_cap(&error) => {
            let mut sized = entries
                .iter()
                .map(|entry| Ok((entry.size()?, entry.label())))
                .collect::<Result<Vec<_>>>()?;
            sized.sort_by_key(|entry| std::cmp::Reverse(entry.0));
            Err(refuse(
                Code::TooLarge,
                format!(
                    "The transfer file would exceed the limit of {} MB after compression.",
                    MAX_FILE_BYTES / (1024 * 1024)
                ),
                sized
                    .into_iter()
                    .take(10)
                    .map(|(size, label)| format!("{label} ({} KB)", size.div_ceil(1024)))
                    .collect(),
                vec![
                    "Push large commits to the remote, or commit, ignore or delete the largest untracked files listed here, then export again.".into(),
                ],
            ))
        }
        Err(error) => Err(error),
    }
}

fn write_unchecked(
    dest: &Path,
    passphrase: &str,
    manifest: &Manifest,
    entries: &[Entry],
) -> Result<u64> {
    let file = std::fs::File::create(dest)
        .with_context(|| format!("creating the transfer file {}", dest.display()))?;
    let capped = Capped {
        inner: BufWriter::new(file),
        written: 0,
    };
    let mut recipient =
        age::scrypt::Recipient::new(age::secrecy::SecretString::from(passphrase.to_owned()));
    recipient.set_work_factor(WORK_FACTOR);
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|e| anyhow::anyhow!("preparing encryption: {e}"))?;
    let sealed = encryptor
        .wrap_output(capped)
        .context("writing the transfer file header")?;
    let gzip = flate2::write::GzEncoder::new(sealed, flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    let manifest = serde_json::to_vec_pretty(manifest)?;
    append(
        &mut tar,
        MANIFEST_ENTRY,
        manifest.len() as u64,
        &manifest[..],
    )?;
    for entry in entries {
        match &entry.source {
            Source::Bytes(bytes) => append(&mut tar, &entry.path, bytes.len() as u64, &bytes[..])?,
            Source::File(path) => {
                let file = std::fs::File::open(path)
                    .with_context(|| format!("reading {}", path.display()))?;
                let size = file.metadata()?.len();
                append(&mut tar, &entry.path, size, file.take(size))?;
            }
        }
    }
    let gzip = tar.into_inner().context("finishing the archive")?;
    let sealed = gzip.finish().context("finishing compression")?;
    let mut capped = sealed.finish().context("finishing encryption")?;
    capped.flush()?;
    let written = capped.written;
    let file = capped
        .inner
        .into_inner()
        .map_err(|e| anyhow::anyhow!("flushing the transfer file: {}", e.error()))?;
    file.sync_all()
        .with_context(|| format!("syncing {}", dest.display()))?;
    Ok(written)
}

fn append<W: Write>(
    tar: &mut tar::Builder<W>,
    path: &str,
    size: u64,
    data: impl Read,
) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_entry_type(tar::EntryType::Regular);
    tar.append_data(&mut header, path, data)
        .with_context(|| format!("adding {path} to the transfer file"))
}

type Plain = flate2::read::GzDecoder<age::stream::StreamReader<BufReader<std::fs::File>>>;

fn open(path: &Path, passphrase: &str) -> Result<tar::Archive<Plain>> {
    let not_transfer = |detail: String| {
        refuse(
            Code::NotTransferFile,
            format!(
                "{} is not a Houston transfer file, or it is damaged.",
                path.display()
            ),
            vec![detail],
            vec!["Choose the .houston-transfer file Houston exported, copied in full.".into()],
        )
    };
    let file = std::fs::File::open(path)
        .with_context(|| format!("opening the transfer file {}", path.display()))?;
    let decryptor = age::Decryptor::new_buffered(BufReader::new(file))
        .map_err(|e| not_transfer(format!("{e}")))?;
    if !decryptor.is_scrypt() {
        return Err(not_transfer("it is not encrypted to a passphrase".into()));
    }
    let mut identity =
        age::scrypt::Identity::new(age::secrecy::SecretString::from(passphrase.to_owned()));
    identity.set_max_work_factor(MAX_WORK_FACTOR);
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| match e {
            age::DecryptError::ExcessiveWork { required, .. } => not_transfer(format!(
                "its passphrase cost 2^{required} exceeds the accepted 2^{MAX_WORK_FACTOR}"
            )),
            age::DecryptError::InvalidHeader | age::DecryptError::UnknownFormat => {
                not_transfer(format!("{e}"))
            }
            _ => refuse(
                Code::WrongPassphrase,
                "The passphrase is wrong or the file is damaged.",
                vec![path.display().to_string()],
                vec!["Enter the passphrase chosen at export, then try again.".into()],
            ),
        })?;
    Ok(tar::Archive::new(flate2::read::GzDecoder::new(reader)))
}

fn damaged(path: &Path, error: impl std::fmt::Display) -> anyhow::Error {
    refuse(
        Code::NotTransferFile,
        format!("The transfer file {} is damaged.", path.display()),
        vec![error.to_string()],
        vec!["Copy the file from the exporting computer again, then import it.".into()],
    )
}

fn read_manifest_entry(path: &Path, entry: &mut impl Read) -> Result<Manifest> {
    let mut raw = Vec::new();
    entry
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| damaged(path, e))?;
    if raw.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(damaged(
            path,
            format!("its manifest exceeds {MAX_MANIFEST_BYTES} bytes"),
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| damaged(path, e))?;
    match value.get("format").and_then(serde_json::Value::as_u64) {
        Some(format) if format == u64::from(FORMAT_VERSION) => {}
        other => {
            return Err(refuse(
                Code::UnknownFormat,
                format!(
                    "The transfer file uses format {}, and this Houston reads format {FORMAT_VERSION}.",
                    other.map_or_else(|| "(none)".to_string(), |f| f.to_string())
                ),
                vec![path.display().to_string()],
                vec!["Update Houston on this computer to the version that exported the file, then import again.".into()],
            ))
        }
    }
    serde_json::from_value(value).map_err(|e| damaged(path, e))
}

/// The manifest alone, without unpacking the rest.
pub fn read_manifest(path: &Path, passphrase: &str) -> Result<Manifest> {
    let mut archive = open(path, passphrase)?;
    let mut entries = archive.entries().map_err(|e| damaged(path, e))?;
    let mut first = entries
        .next()
        .ok_or_else(|| damaged(path, "it is empty"))?
        .map_err(|e| damaged(path, e))?;
    let name = first.path().map_err(|e| damaged(path, e))?.into_owned();
    if name != Path::new(MANIFEST_ENTRY) {
        bail!(damaged(
            path,
            format!(
                "its first entry is {}, not {MANIFEST_ENTRY}",
                name.display()
            )
        ));
    }
    read_manifest_entry(path, &mut first)
}

/// Unpacks every entry under `into` and returns the manifest. Only regular files with
/// relative, non-escaping paths are accepted.
pub fn unpack(path: &Path, passphrase: &str, into: &Path) -> Result<Manifest> {
    let mut archive = open(path, passphrase)?;
    let mut manifest = None;
    let mut total = 0u64;
    for entry in archive.entries().map_err(|e| damaged(path, e))? {
        let mut entry = entry.map_err(|e| damaged(path, e))?;
        let name = entry.path().map_err(|e| damaged(path, e))?.into_owned();
        if manifest.is_none() {
            if name != Path::new(MANIFEST_ENTRY) {
                bail!(damaged(
                    path,
                    format!(
                        "its first entry is {}, not {MANIFEST_ENTRY}",
                        name.display()
                    )
                ));
            }
            manifest = Some(read_manifest_entry(path, &mut entry)?);
            continue;
        }
        let relative = safe_relative(&name).ok_or_else(|| {
            damaged(
                path,
                format!("entry {} escapes the archive", name.display()),
            )
        })?;
        if entry.header().entry_type() != tar::EntryType::Regular {
            bail!(damaged(
                path,
                format!(
                    "entry {} is not a regular file ({:?})",
                    name.display(),
                    entry.header().entry_type()
                )
            ));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_UNPACKED_BYTES {
            bail!(damaged(
                path,
                format!("it unpacks to more than {MAX_UNPACKED_BYTES} bytes")
            ));
        }
        let dest = into.join(relative);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let mut out =
            std::fs::File::create(&dest).with_context(|| format!("creating {}", dest.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| damaged(path, e))?;
    }
    manifest.ok_or_else(|| damaged(path, "it is empty"))
}

/// `name` as a relative path of normal components only.
pub fn safe_relative(name: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in name.components() {
        match component {
            Component::Normal(part) if !part.to_string_lossy().contains(['\0', ':']) => {
                out.push(part)
            }
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::manifest::WorkspaceEntry;
    use crate::transfer::refusal;

    fn manifest() -> Manifest {
        Manifest {
            format: FORMAT_VERSION,
            transfer_id: "t1".into(),
            created_at_ms: 1,
            source_os: std::env::consts::OS.into(),
            houston_version: "0".into(),
            workspace: WorkspaceEntry {
                path: "/w".into(),
                name: "w".into(),
                remote_url: None,
            },
            cli_versions: Vec::new(),
            checkouts: Vec::new(),
            panes: Vec::new(),
            skipped: Vec::new(),
            skipped_links: Vec::new(),
            grids: "{}".into(),
        }
    }

    #[test]
    fn a_file_round_trips_and_a_wrong_passphrase_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.houston-transfer");
        let entries = vec![Entry {
            path: "checkouts/0/untracked/notes.txt".into(),
            source: Source::Bytes(b"notes".to_vec()),
        }];
        write(&file, "correct horse", &manifest(), &entries).unwrap();
        assert_eq!(
            read_manifest(&file, "correct horse").unwrap().transfer_id,
            "t1"
        );
        let out = dir.path().join("out");
        unpack(&file, "correct horse", &out).unwrap();
        assert_eq!(
            std::fs::read(out.join("checkouts/0/untracked/notes.txt")).unwrap(),
            b"notes"
        );
        let error = read_manifest(&file, "wrong").unwrap_err();
        let refusal = refusal(&error).expect("a refusal");
        assert_eq!(refusal.code, Code::WrongPassphrase);
        assert_eq!(
            refusal.problem,
            "The passphrase is wrong or the file is damaged."
        );
    }

    #[test]
    fn a_file_that_is_not_age_is_refused_as_not_a_transfer_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plain.houston-transfer");
        std::fs::write(&file, b"just text").unwrap();
        let error = read_manifest(&file, "x").unwrap_err();
        assert_eq!(refusal(&error).unwrap().code, Code::NotTransferFile);
    }

    #[test]
    fn an_unknown_format_names_both_versions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("future.houston-transfer");
        let mut future = manifest();
        future.format = FORMAT_VERSION + 1;
        write(&file, "p", &future, &[]).unwrap();
        let error = read_manifest(&file, "p").unwrap_err();
        let refusal = refusal(&error).unwrap();
        assert_eq!(refusal.code, Code::UnknownFormat);
        assert!(
            refusal
                .problem
                .contains(&format!("format {}", FORMAT_VERSION + 1))
                && refusal
                    .problem
                    .contains(&format!("reads format {FORMAT_VERSION}")),
            "{}",
            refusal.problem
        );
    }

    #[test]
    fn entries_that_escape_the_archive_are_refused() {
        for name in ["../x", "/etc/passwd", "a/../../b", "C:/x", ""] {
            assert_eq!(safe_relative(Path::new(name)), None, "{name}");
        }
        assert_eq!(
            safe_relative(Path::new("transcripts/0/a.jsonl")),
            Some(PathBuf::from("transcripts/0/a.jsonl"))
        );
    }

    #[test]
    fn a_traversal_entry_in_a_real_file_is_refused_at_unpack() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("evil.houston-transfer");
        {
            let out = std::fs::File::create(&file).unwrap();
            let mut recipient =
                age::scrypt::Recipient::new(age::secrecy::SecretString::from("p".to_owned()));
            recipient.set_work_factor(WORK_FACTOR);
            let sealed =
                age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
                    .unwrap()
                    .wrap_output(out)
                    .unwrap();
            let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
                sealed,
                flate2::Compression::default(),
            ));
            let manifest = serde_json::to_vec(&manifest()).unwrap();
            append(
                &mut tar,
                MANIFEST_ENTRY,
                manifest.len() as u64,
                &manifest[..],
            )
            .unwrap();
            let mut header = tar::Header::new_gnu();
            header.set_size(1);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            // `append_data` refuses `..`, so write the raw name the way a crafted file would.
            let name = b"../escaped";
            header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
            header.set_cksum();
            tar.append(&header, &b"x"[..]).unwrap();
            tar.into_inner()
                .unwrap()
                .finish()
                .unwrap()
                .finish()
                .unwrap();
        }
        let out = dir.path().join("out");
        let error = unpack(&file, "p", &out).unwrap_err();
        assert!(
            format!("{error:#}").contains("escapes the archive"),
            "{error:#}"
        );
        assert!(!dir.path().join("escaped").exists());
    }
}
