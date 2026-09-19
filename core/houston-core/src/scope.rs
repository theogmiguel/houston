use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub const MAIL_FORMAT_VERSION: u32 = 1;

// Reader-side caps: the mailbox is written by an untrusted external writer, so
// these bound a record at the boundary before it is parsed in.
pub const ID_MAX_LEN: usize = 240;
pub const LABEL_MAX_LEN: usize = 160;
pub const BODY_MAX_LEN: usize = 20_000;

pub struct ScopeLayout {
    pub scope: PathBuf,
    pub bin: PathBuf,
    pub transcript: PathBuf,
    pub status: PathBuf,
    pub nudges: PathBuf,
    pub plan_events: PathBuf,
    pub plan_state: PathBuf,
    pub hook_drop: PathBuf,
    inbox_root: PathBuf,
}

impl ScopeLayout {
    pub fn new(root: &Path, swarm_id: u64) -> Self {
        Self::from_scope(scope_dir(root, swarm_id))
    }

    pub fn from_scope(scope: PathBuf) -> Self {
        Self {
            bin: scope.join("bin"),
            transcript: scope.join("transcript"),
            status: scope.join("status"),
            nudges: scope.join("nudges"),
            plan_events: scope.join("plan").join("events"),
            plan_state: scope.join("plan").join("state.json"),
            hook_drop: crate::hook_drop::drop_dir(&scope),
            inbox_root: scope.join("inbox"),
            scope,
        }
    }

    pub fn inbox_for(&self, address: &str) -> Result<PathBuf> {
        validate_path_component(address)?;
        Ok(self.inbox_root.join(address))
    }

    pub fn nudge_filename(&self, address: &str) -> Result<String> {
        validate_path_component(address)?;
        Ok(format!("{address}.txt"))
    }

    pub fn create_all(&self, labels: &[String]) -> Result<()> {
        for dir in [
            &self.bin,
            &self.transcript,
            &self.status,
            &self.nudges,
            &self.plan_events,
            &self.hook_drop,
        ] {
            create_dir(dir)?;
        }
        create_dir(&self.inbox_for(ADDR_OPERATOR)?)?;

        let mut seen_lower = std::collections::HashSet::new();
        for label in labels {
            let lower = label.to_lowercase();
            if !seen_lower.insert(lower.clone()) {
                bail!(
                    "agent label {label:?} collides case-insensitively with another label \
                     in this scope ({lower:?} lowercased) — a case-insensitive filesystem \
                     would merge their inbox directories into one"
                );
            }
            create_dir(&self.inbox_for(label)?)?;
        }
        Ok(())
    }
}

fn create_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))
}

fn validate_path_component(label: &str) -> Result<()> {
    if label.is_empty() {
        bail!("mailbox address {label:?} is empty, not a valid path component");
    }
    if label == "." || label == ".." {
        bail!("mailbox address {label:?} is a path-traversal component, not a valid inbox address");
    }
    if label.contains('/') || label.contains('\0') {
        bail!(
            "mailbox address {label:?} contains a path separator or NUL byte, \
             not a valid inbox address"
        );
    }
    if Path::new(label).is_absolute() {
        bail!("mailbox address {label:?} is an absolute path, not a valid inbox address");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub body: String,
    pub kind: proto::SwarmMsgKind,
    pub timestamp_ms: u64,
}

#[derive(Deserialize)]
struct MailFileRaw {
    v: Option<u32>,
    id: Option<String>,
    from: Option<String>,
    to: Option<String>,
    body: Option<String>,
    kind: Option<String>,
    timestamp: Option<u64>,
}

#[derive(Serialize)]
struct MailFileWire<'a> {
    v: u32,
    id: &'a str,
    from: &'a str,
    to: &'a str,
    body: &'a str,
    kind: proto::SwarmMsgKind,
    timestamp: u64,
}

impl MailMessage {
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let wire = MailFileWire {
            v: MAIL_FORMAT_VERSION,
            id: &self.id,
            from: &self.from,
            to: &self.to,
            body: &self.body,
            kind: self.kind,
            timestamp: self.timestamp_ms,
        };
        serde_json::to_vec(&wire).context("serializing mailbox message")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let raw: MailFileRaw =
            serde_json::from_slice(bytes).context("mailbox message is not valid JSON")?;

        let v = raw
            .v
            .context("mailbox message missing required field `v`")?;
        if v != MAIL_FORMAT_VERSION {
            bail!(
                "mailbox message format version {v} is not supported, expected {MAIL_FORMAT_VERSION}"
            );
        }

        let id = raw
            .id
            .context("mailbox message missing required field `id`")?;
        if id.len() > ID_MAX_LEN {
            bail!(
                "mailbox message `id` is {} bytes, expected <= {ID_MAX_LEN}: {id:?}",
                id.len()
            );
        }

        let from = raw
            .from
            .context("mailbox message missing required field `from`")?;
        if from.len() > LABEL_MAX_LEN {
            bail!(
                "mailbox message `from` is {} bytes, expected <= {LABEL_MAX_LEN}: {from:?}",
                from.len()
            );
        }

        let body = raw
            .body
            .context("mailbox message missing required field `body`")?;
        if body.len() > BODY_MAX_LEN {
            bail!(
                "mailbox message `body` is {} bytes, expected <= {BODY_MAX_LEN}",
                body.len()
            );
        }

        let to = raw.to.unwrap_or_default();
        if to.len() > LABEL_MAX_LEN {
            bail!(
                "mailbox message `to` is {} bytes, expected <= {LABEL_MAX_LEN}: {to:?}",
                to.len()
            );
        }

        let kind = match raw.kind.as_deref() {
            Some("message") => proto::SwarmMsgKind::Message,
            Some("status") => proto::SwarmMsgKind::Status,
            Some("escalation") => proto::SwarmMsgKind::Escalation,
            Some("worker_done") => proto::SwarmMsgKind::WorkerDone,
            Some("swarm_complete") => proto::SwarmMsgKind::SwarmComplete,
            _ => proto::SwarmMsgKind::Message,
        };

        Ok(MailMessage {
            id,
            from,
            to,
            body,
            kind,
            timestamp_ms: raw.timestamp.unwrap_or(0),
        })
    }
}

pub fn mail_filename(id: &str) -> String {
    format!("{id}.json")
}

pub fn gen_mailbox_id() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(ms);
    h.write_u32(std::process::id());
    let r = (h.finish() & 0xffff_ffff) as u32;
    format_mailbox_id(ms, r)
}

fn format_mailbox_id(ms: u64, rand_suffix: u32) -> String {
    format!("{ms:013}-{rand_suffix:08x}")
}

// The EXACT shape (13 digits, `-`, 8 hex), not just a digit prefix: a seed file
// like `0000000000000-seed-primary-goal.json` parses its leading digits as ms=0,
// so a prefix-only GC would delete it as epoch-old. Off-shape means never delete.
pub(crate) fn parse_mailbox_id_ms(stem: &str) -> Option<u64> {
    let bytes = stem.as_bytes();
    if bytes.len() != 13 + 1 + 8 || bytes[13] != b'-' {
        return None;
    }
    let ms_part = &stem[..13];
    let rand_part = &stem[14..];
    if !ms_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !rand_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    ms_part.parse::<u64>().ok()
}

#[cfg(unix)]
pub(crate) fn is_json_filename(name: &OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;
    name.as_bytes().ends_with(b".json")
}

#[cfg(windows)]
pub(crate) fn is_json_filename(name: &OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    const JSON_SUFFIX: [u16; 5] = [
        b'.' as u16,
        b'j' as u16,
        b's' as u16,
        b'o' as u16,
        b'n' as u16,
    ];
    let units: Vec<u16> = name.encode_wide().collect();
    units.ends_with(&JSON_SUFFIX)
}

pub struct MailboxReader {
    seen: HashMap<PathBuf, HashSet<OsString>>,
    last_listing: HashMap<PathBuf, Vec<OsString>>,
    last_listing_ok: HashMap<PathBuf, bool>,
}

impl MailboxReader {
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
            last_listing: HashMap::new(),
            last_listing_ok: HashMap::new(),
        }
    }

    pub fn last_listing(&self, dir: &Path) -> &[OsString] {
        self.last_listing
            .get(dir)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn last_listing_ok(&self, dir: &Path) -> bool {
        self.last_listing_ok.get(dir).copied().unwrap_or(false)
    }

    pub fn poll(&mut self, dir: &Path) -> Vec<MailMessage> {
        let read_dir = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.last_listing.insert(dir.to_path_buf(), Vec::new());
                self.last_listing_ok.insert(dir.to_path_buf(), true);
                return Vec::new();
            }
            Err(e) => {
                tracing::warn!("mailbox: failed to list {}: {e}", dir.display());
                self.last_listing_ok.insert(dir.to_path_buf(), false);
                return Vec::new();
            }
        };

        let mut names: Vec<OsString> = Vec::new();
        for entry in read_dir {
            match entry {
                Ok(entry) => {
                    let name = entry.file_name();
                    if is_json_filename(&name) {
                        names.push(name);
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "mailbox: failed to read a directory entry in {}: {e}",
                        dir.display()
                    );
                }
            }
        }
        names.sort();

        let seen_for_dir = self.seen.entry(dir.to_path_buf()).or_default();

        let mut out = Vec::new();
        for name in &names {
            if seen_for_dir.contains(name) {
                continue;
            }
            seen_for_dir.insert(name.clone());

            let path = dir.join(name);
            let parsed = std::fs::read(&path)
                .context("reading mailbox message file")
                .and_then(|bytes| MailMessage::from_bytes(&bytes));
            match parsed {
                Ok(msg) => out.push(msg),
                Err(e) => {
                    tracing::warn!("mailbox: failed to read {}: {e:#}", path.display());
                    seen_for_dir.remove(name);
                }
            }
        }

        let present: HashSet<&OsStr> = names.iter().map(|n| n.as_os_str()).collect();
        seen_for_dir.retain(|name| present.contains(name.as_os_str()));

        self.last_listing.insert(dir.to_path_buf(), names);
        self.last_listing_ok.insert(dir.to_path_buf(), true);

        out
    }

    pub fn unsee(&mut self, dir: &Path, name: &OsStr) {
        if let Some(seen_for_dir) = self.seen.get_mut(dir) {
            seen_for_dir.remove(name);
        }
    }
}

impl Default for MailboxReader {
    fn default() -> Self {
        Self::new()
    }
}

pub const ADDR_OPERATOR: &str = "@operator";

pub const ADDR_ALL: &str = "@all";

pub const FROM_OPERATOR: &str = "Operator";

pub fn scope_dir(root: &Path, swarm: u64) -> PathBuf {
    root.join(crate::paths::PROJECT_DIR)
        .join("swarm")
        .join(swarm.to_string())
}

pub fn resolve_recipients(to: &str, from: &str, labels: &[String]) -> Result<Vec<String>> {
    if to == ADDR_OPERATOR {
        return Ok(Vec::new());
    }
    if to == ADDR_ALL {
        return Ok(labels.iter().filter(|l| *l != from).cloned().collect());
    }
    if labels.iter().any(|l| l == to) {
        return Ok(vec![to.to_string()]);
    }
    bail!(
        "unknown recipient {to:?} — expected {ADDR_ALL}, {ADDR_OPERATOR}, or one of: {}",
        labels.join(", ")
    )
}

pub fn init_scope(root: &Path, swarm: u64, exe: &Path) -> Result<PathBuf> {
    let scope = scope_dir(root, swarm);
    let bin = scope.join("bin");
    std::fs::create_dir_all(&bin).with_context(|| format!("creating {}", bin.display()))?;
    let swarm_root = root.join(crate::paths::PROJECT_DIR).join("swarm");
    let gitignore = swarm_root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, "*\n")
            .with_context(|| format!("writing {}", gitignore.display()))?;
    }
    let helper = crate::exe_path::agent_helper_exe(exe);
    let name = "hs-swarm";
    let exe_display = crate::exe_path::ascii_safe(&helper).display().to_string();
    let (file_name, script) = if cfg!(windows) {
        (
            format!("{name}.cmd"),
            format!("@{} {name} %*\n", batch_quote(&exe_display)),
        )
    } else {
        (
            name.to_string(),
            format!(
                "#!/bin/sh\n# HoustonSwarm helper - talks to the Houston daemon.\nexec {} {name} \"$@\"\n",
                shell_quote(&helper.display().to_string()),
            ),
        )
    };
    let path = bin.join(file_name);
    std::fs::write(&path, script).with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod {}", path.display()))?;
    }
    Ok(scope)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn batch_quote(s: &str) -> String {
    if s.contains(' ') {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook_drop::write_atomic;

    #[test]
    fn scope_layout_extends_swarm_scope_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 7);
        assert_eq!(layout.scope, scope_dir(tmp.path(), 7));
        assert_eq!(layout.bin, layout.scope.join("bin"));
        assert_eq!(layout.transcript, layout.scope.join("transcript"));
        assert_eq!(layout.plan_events, layout.scope.join("plan").join("events"));
    }

    #[test]
    fn create_all_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        let labels = vec!["Alice".to_string(), "Bob".to_string()];
        layout.create_all(&labels).unwrap();
        layout.create_all(&labels).unwrap();

        for dir in [
            &layout.bin,
            &layout.transcript,
            &layout.status,
            &layout.nudges,
            &layout.plan_events,
            &layout.inbox_for(ADDR_OPERATOR).unwrap(),
            &layout.inbox_for("Alice").unwrap(),
            &layout.inbox_for("Bob").unwrap(),
        ] {
            assert!(dir.is_dir(), "expected dir to exist: {}", dir.display());
        }
    }

    #[test]
    fn inbox_for_rejects_path_traversal_label() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        let err = layout.inbox_for("..").unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains(".."),
            "error should name the offending label: {text}"
        );
    }

    #[test]
    fn inbox_for_rejects_label_with_path_separator() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        let err = layout.inbox_for("../../etc/passwd").unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("../../etc/passwd"),
            "error should name the offending label: {text}"
        );

        let err = layout.inbox_for("evil/label").unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("evil/label"),
            "error should name the offending label: {text}"
        );
    }

    #[test]
    fn inbox_for_rejects_empty_and_dot_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        assert!(layout.inbox_for("").is_err());
        assert!(layout.inbox_for(".").is_err());
    }

    #[test]
    fn inbox_for_rejects_absolute_path_label() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        let err = layout.inbox_for("/etc/passwd").unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("/etc/passwd"),
            "error should name the offending label: {text}"
        );
    }

    #[test]
    fn reserved_addresses_still_resolve_through_the_same_validator() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        assert!(layout.inbox_for(ADDR_OPERATOR).is_ok());
        assert!(layout.inbox_for(ADDR_ALL).is_ok());
    }

    #[test]
    fn create_all_rejects_case_colliding_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = ScopeLayout::new(tmp.path(), 1);
        let labels = vec!["Alice".to_string(), "alice".to_string()];
        let err = layout.create_all(&labels).unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("alice"),
            "error should name the colliding label: {text}"
        );
    }

    #[test]
    fn write_atomic_round_trips_through_the_parser() {
        let tmp = tempfile::tempdir().unwrap();
        let msg = MailMessage {
            id: gen_mailbox_id(),
            from: "Alice".to_string(),
            to: "Bob".to_string(),
            body: "hello".to_string(),
            kind: proto::SwarmMsgKind::Message,
            timestamp_ms: 1_700_000_000_123,
        };
        let name = mail_filename(&msg.id);
        write_atomic(tmp.path(), &name, &msg.to_bytes().unwrap()).unwrap();

        let bytes = std::fs::read(tmp.path().join(&name)).unwrap();
        let round_tripped = MailMessage::from_bytes(&bytes).unwrap();
        assert_eq!(round_tripped, msg);
    }
    #[test]
    fn write_atomic_temp_file_never_looks_like_a_finished_message() {
        let tmp = tempfile::tempdir().unwrap();
        let temp = tempfile::NamedTempFile::new_in(tmp.path()).unwrap();
        let name = temp.path().file_name().unwrap().to_str().unwrap();
        assert!(
            !name.ends_with(".json"),
            "temp file {name:?} must never end in .json — readers filter on that suffix"
        );
    }

    #[test]
    fn oversized_id_is_rejected_by_name() {
        let msg = format!(
            r#"{{"v":1,"id":"{}","from":"a","to":"b","body":"x","kind":"message","timestamp":1}}"#,
            "x".repeat(ID_MAX_LEN + 1)
        );
        let err = MailMessage::from_bytes(msg.as_bytes()).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("id"), "error should name the field: {text}");
        assert!(
            text.contains(&(ID_MAX_LEN + 1).to_string()),
            "error should name the offending length: {text}"
        );
        assert!(
            text.contains(&ID_MAX_LEN.to_string()),
            "error should name the expected cap: {text}"
        );
    }

    #[test]
    fn oversized_from_is_rejected_by_name() {
        let msg = format!(
            r#"{{"v":1,"id":"i","from":"{}","to":"b","body":"x","kind":"message","timestamp":1}}"#,
            "x".repeat(LABEL_MAX_LEN + 1)
        );
        let err = MailMessage::from_bytes(msg.as_bytes()).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("from"), "error should name the field: {text}");
    }

    #[test]
    fn oversized_to_is_rejected_by_name() {
        let msg = format!(
            r#"{{"v":1,"id":"i","from":"a","to":"{}","body":"x","kind":"message","timestamp":1}}"#,
            "x".repeat(LABEL_MAX_LEN + 1)
        );
        let err = MailMessage::from_bytes(msg.as_bytes()).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("to"), "error should name the field: {text}");
    }

    #[test]
    fn oversized_body_is_rejected_by_name() {
        let msg = format!(
            r#"{{"v":1,"id":"i","from":"a","to":"b","body":"{}","kind":"message","timestamp":1}}"#,
            "x".repeat(BODY_MAX_LEN + 1)
        );
        let err = MailMessage::from_bytes(msg.as_bytes()).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("body"), "error should name the field: {text}");
    }

    #[test]
    fn missing_required_fields_are_dropped() {
        assert!(MailMessage::from_bytes(br#"{"v":1,"from":"a","to":"b","body":"x"}"#).is_err());
        assert!(MailMessage::from_bytes(br#"{"v":1,"id":"i","to":"b","body":"x"}"#).is_err());
        assert!(MailMessage::from_bytes(br#"{"v":1,"id":"i","from":"a","to":"b"}"#).is_err());
    }

    #[test]
    fn unknown_kind_coerces_to_message() {
        let msg =
            br#"{"v":1,"id":"i","from":"a","to":"b","body":"x","kind":"totally_unknown_kind","timestamp":1}"#;
        let parsed = MailMessage::from_bytes(msg).unwrap();
        assert_eq!(parsed.kind, proto::SwarmMsgKind::Message);
    }

    #[test]
    fn unrecognised_format_version_is_rejected_by_number() {
        let msg =
            br#"{"v":2,"id":"i","from":"a","to":"b","body":"x","kind":"message","timestamp":1}"#;
        let err = MailMessage::from_bytes(msg).unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains('2'),
            "error should name the version found: {text}"
        );
        assert!(
            text.contains(&MAIL_FORMAT_VERSION.to_string()),
            "error should name the version supported: {text}"
        );
    }

    #[test]
    fn missing_format_version_is_rejected() {
        let msg = br#"{"id":"i","from":"a","to":"b","body":"x","kind":"message","timestamp":1}"#;
        let err = MailMessage::from_bytes(msg).unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains('v'),
            "error should name the missing field: {text}"
        );
    }

    #[test]
    fn non_integer_format_version_is_rejected() {
        let msg = br#"{"v":"two","id":"i","from":"a","to":"b","body":"x","kind":"message","timestamp":1}"#;
        assert!(MailMessage::from_bytes(msg).is_err());
    }

    #[test]
    fn multibyte_body_is_capped_by_bytes_not_chars() {
        let under = "é".repeat(BODY_MAX_LEN / 2 - 1);
        assert!(under.len() < BODY_MAX_LEN);
        let msg_under = serde_json::json!({
            "v": MAIL_FORMAT_VERSION, "id": "i", "from": "a", "to": "b",
            "body": under, "kind": "message", "timestamp": 1,
        });
        assert!(MailMessage::from_bytes(&serde_json::to_vec(&msg_under).unwrap()).is_ok());

        let over = "é".repeat(BODY_MAX_LEN / 2 + 1);
        assert!(over.len() > BODY_MAX_LEN);
        let msg_over = serde_json::json!({
            "v": MAIL_FORMAT_VERSION, "id": "i", "from": "a", "to": "b",
            "body": over, "kind": "message", "timestamp": 1,
        });
        let err = MailMessage::from_bytes(&serde_json::to_vec(&msg_over).unwrap()).unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("bytes"),
            "error should say bytes, not chars: {text}"
        );
    }

    #[test]
    fn serialized_message_matches_the_exact_on_disk_json() {
        let msg = MailMessage {
            id: "0000000000001-deadbeef".to_string(),
            from: "Alice".to_string(),
            to: "Bob".to_string(),
            body: "hello".to_string(),
            kind: proto::SwarmMsgKind::Escalation,
            timestamp_ms: 1_700_000_000_123,
        };
        let bytes = msg.to_bytes().unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(
            text,
            r#"{"v":1,"id":"0000000000001-deadbeef","from":"Alice","to":"Bob","body":"hello","kind":"escalation","timestamp":1700000000123}"#
        );

        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<&str> = parsed
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["body", "from", "id", "kind", "timestamp", "to", "v"]
        );
    }

    #[test]
    fn ids_a_millisecond_apart_sort_chronologically_as_filenames() {
        let earlier = format_mailbox_id(1_700_000_000_000, 0xdead_beef);
        let later = format_mailbox_id(1_700_000_000_001, 0x0000_0000);
        assert!(
            earlier < later,
            "ids must sort lexicographically in time order: {earlier:?} vs {later:?}"
        );
    }

    fn mail(id: &str, body: &str) -> MailMessage {
        MailMessage {
            id: id.to_string(),
            from: "Alice".to_string(),
            to: "Bob".to_string(),
            body: body.to_string(),
            kind: proto::SwarmMsgKind::Message,
            timestamp_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn poll_delivers_a_valid_message_once_not_twice() {
        let tmp = tempfile::tempdir().unwrap();
        let msg = mail(&gen_mailbox_id(), "hello");
        write_atomic(
            tmp.path(),
            &mail_filename(&msg.id),
            &msg.to_bytes().unwrap(),
        )
        .unwrap();

        let mut reader = MailboxReader::new();
        let first = reader.poll(tmp.path());
        assert_eq!(first, vec![msg]);

        let second = reader.poll(tmp.path());
        assert!(
            second.is_empty(),
            "already-delivered message redelivered: {second:?}"
        );
    }

    #[test]
    fn poll_retries_a_corrupt_file_and_does_not_abort_delivery_of_others() {
        let tmp = tempfile::tempdir().unwrap();
        let good = mail(&gen_mailbox_id(), "good");
        write_atomic(
            tmp.path(),
            &mail_filename(&good.id),
            &good.to_bytes().unwrap(),
        )
        .unwrap();
        std::fs::write(tmp.path().join("corrupt.json"), b"not json at all").unwrap();

        let mut reader = MailboxReader::new();
        let first = reader.poll(tmp.path());
        assert_eq!(
            first,
            vec![good.clone()],
            "the valid message must still be delivered despite the corrupt sibling"
        );

        let second = reader.poll(tmp.path());
        assert!(
            second.is_empty(),
            "valid message redelivered, corrupt file must still fail to parse: {second:?}"
        );

        let fixed = mail("corrupt", "now valid");
        write_atomic(tmp.path(), "corrupt.json", &fixed.to_bytes().unwrap()).unwrap();
        let third = reader.poll(tmp.path());
        assert_eq!(third, vec![fixed]);
    }

    #[test]
    fn poll_ignores_non_json_files_including_an_in_progress_write() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("notes.txt"), b"not a mailbox file").unwrap();
        let _mid_write = tempfile::NamedTempFile::new_in(tmp.path()).unwrap();

        let msg = mail(&gen_mailbox_id(), "hello");
        write_atomic(
            tmp.path(),
            &mail_filename(&msg.id),
            &msg.to_bytes().unwrap(),
        )
        .unwrap();

        let mut reader = MailboxReader::new();
        let delivered = reader.poll(tmp.path());
        assert_eq!(delivered, vec![msg]);
    }

    #[test]
    fn poll_of_missing_directory_yields_zero_messages_no_error() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");

        let mut reader = MailboxReader::new();
        let delivered = reader.poll(&missing);
        assert!(delivered.is_empty());
    }

    #[test]
    fn poll_orders_results_by_filename_chronology() {
        let tmp = tempfile::tempdir().unwrap();
        let earlier_id = format_mailbox_id(1_700_000_000_000, 0);
        let later_id = format_mailbox_id(1_700_000_000_001, 0);
        let earlier = mail(&earlier_id, "earlier");
        let later = mail(&later_id, "later");

        write_atomic(
            tmp.path(),
            &mail_filename(&later.id),
            &later.to_bytes().unwrap(),
        )
        .unwrap();
        write_atomic(
            tmp.path(),
            &mail_filename(&earlier.id),
            &earlier.to_bytes().unwrap(),
        )
        .unwrap();

        let mut reader = MailboxReader::new();
        let delivered = reader.poll(tmp.path());
        assert_eq!(delivered, vec![earlier, later]);
    }

    #[test]
    fn poll_prunes_seen_key_for_a_deleted_file_so_a_recreated_file_is_redelivered() {
        let tmp = tempfile::tempdir().unwrap();
        let msg = mail("stable-id", "hello");
        let name = mail_filename(&msg.id);
        write_atomic(tmp.path(), &name, &msg.to_bytes().unwrap()).unwrap();

        let mut reader = MailboxReader::new();
        assert_eq!(reader.poll(tmp.path()), vec![msg.clone()]);

        std::fs::remove_file(tmp.path().join(&name)).unwrap();
        assert!(reader.poll(tmp.path()).is_empty());

        write_atomic(tmp.path(), &name, &msg.to_bytes().unwrap()).unwrap();
        assert_eq!(
            reader.poll(tmp.path()),
            vec![msg],
            "seen-key for the deleted file must have been pruned, allowing redelivery"
        );
    }

    #[derive(Clone, Default)]
    #[cfg(unix)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    #[cfg(unix)]
    impl std::io::Write for LogBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[cfg(unix)]
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[cfg(unix)]
    #[test]
    fn poll_of_unlistable_directory_warns_and_yields_zero_messages() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let locked = tmp.path().join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        let original_mode = std::fs::metadata(&locked).unwrap().permissions().mode();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        if unsafe { libc::geteuid() } == 0 {
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(original_mode))
                .unwrap();
            eprintln!("skipping poll_of_unlistable_directory_warns_and_yields_zero_messages: running as root, permissions are not enforced");
            return;
        }

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let delivered = tracing::subscriber::with_default(subscriber, || {
            let mut reader = MailboxReader::new();
            reader.poll(&locked)
        });

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(original_mode)).unwrap();

        assert!(delivered.is_empty());
        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains(&locked.display().to_string()),
            "warning should name the unlistable directory: {logged}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn poll_retries_a_non_utf8_named_json_file() {
        use std::os::unix::ffi::OsStrExt;

        let tmp = tempfile::tempdir().unwrap();
        let mut raw = b"\xffbad".to_vec();
        raw.extend_from_slice(b".json");
        assert!(
            std::str::from_utf8(&raw).is_err(),
            "fixture filename must actually be non-UTF-8"
        );
        let name = std::ffi::OsStr::from_bytes(&raw).to_os_string();
        std::fs::write(tmp.path().join(&name), b"not valid json").unwrap();

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let (first, second) = tracing::subscriber::with_default(subscriber, || {
            let mut reader = MailboxReader::new();
            let first = reader.poll(tmp.path());
            let second = reader.poll(tmp.path());
            (first, second)
        });
        assert!(
            first.is_empty(),
            "invalid JSON must not parse as a message: {first:?}"
        );
        assert!(
            second.is_empty(),
            "still invalid JSON on retry, must still fail to parse: {second:?}"
        );
        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        let occurrences = logged.matches("failed to read").count();
        assert_eq!(
            occurrences, 2,
            "the non-UTF-8-named file must be retried (warned twice), not silently dropped: {logged}"
        );
    }

    #[test]
    fn poll_keys_by_directory_so_the_same_filename_in_two_dirs_both_deliver() {
        let tmp = tempfile::tempdir().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();

        let msg_a = mail("same-id", "from a");
        let msg_b = mail("same-id", "from b");
        let name = mail_filename("same-id");
        write_atomic(&dir_a, &name, &msg_a.to_bytes().unwrap()).unwrap();
        write_atomic(&dir_b, &name, &msg_b.to_bytes().unwrap()).unwrap();

        let mut reader = MailboxReader::new();
        assert_eq!(reader.poll(&dir_a), vec![msg_a]);
        assert_eq!(reader.poll(&dir_b), vec![msg_b]);
    }

    #[test]
    fn representative_message_and_event_byte_sizes_for_the_retention_receipt() {
        let tmp = tempfile::tempdir().unwrap();

        let msg = MailMessage {
            id: gen_mailbox_id(),
            from: "Alice".to_string(),
            to: "Bob".to_string(),
            body: "Implemented the parser fix and reran the suite; all green. Moving on to \
                   the next task now."
                .to_string(),
            kind: proto::SwarmMsgKind::Message,
            timestamp_ms: 1_700_000_000_000,
        };
        let msg_bytes = msg.to_bytes().unwrap();
        write_atomic(tmp.path(), &mail_filename(&msg.id), &msg_bytes).unwrap();
        let msg_file_len = std::fs::metadata(tmp.path().join(mail_filename(&msg.id)))
            .unwrap()
            .len();
        eprintln!("representative mail message: {msg_file_len} bytes on disk");
        const RECEIPTED_MAIL_MESSAGE_BYTES: u64 = 206;
        assert_eq!(
            msg_file_len, RECEIPTED_MAIL_MESSAGE_BYTES,
            "representative mail message size no longer matches the {RECEIPTED_MAIL_MESSAGE_BYTES} \
             bytes the retention receipt in daemon.rs (SWARM_MAIL_GC_RETENTION_MS's doc comment) \
             derives its arithmetic from — re-derive that receipt and update both the cited byte \
             count and this constant in the same edit"
        );
    }
}

#[cfg(test)]
mod relocated_swarm_tests {
    use super::*;

    #[test]
    fn recipients_all_excludes_sender_and_operator_gets_none() {
        let labels = vec!["Coordinator".to_string(), "Builder-1".to_string()];
        let all = resolve_recipients(ADDR_ALL, "Coordinator", &labels).unwrap();
        assert_eq!(all, vec!["Builder-1".to_string()]);
        assert!(resolve_recipients(ADDR_OPERATOR, "Builder-1", &labels)
            .unwrap()
            .is_empty());
        let err = resolve_recipients("Ghost", "Builder-1", &labels)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Ghost") && err.contains("Builder-1"), "{err}");
    }

    #[test]
    fn scope_scaffold_installs_the_swarm_wrapper_and_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        let scope = init_scope(tmp.path(), 3, Path::new("/opt/houston core/houston-core")).unwrap();
        assert_eq!(scope, tmp.path().join(".houston/swarm/3"));
        let gi = std::fs::read_to_string(tmp.path().join(".houston/swarm/.gitignore")).unwrap();
        assert_eq!(gi, "*\n");
        #[cfg(windows)]
        {
            let swarm = std::fs::read_to_string(scope.join("bin/hs-swarm.cmd")).unwrap();
            assert_eq!(swarm, "@\"/opt/houston core/houston-core\" hs-swarm %*\n");
        }
        #[cfg(unix)]
        {
            let swarm = std::fs::read_to_string(scope.join("bin/hs-swarm")).unwrap();
            assert!(swarm.contains("exec '/opt/houston core/houston-core' hs-swarm \"$@\""));
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(scope.join("bin/hs-swarm"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "the wrapper must be executable");
        }
        init_scope(tmp.path(), 3, Path::new("/other/exe")).unwrap();
        let swarm_name = if cfg!(windows) {
            "bin/hs-swarm.cmd"
        } else {
            "bin/hs-swarm"
        };
        let swarm = std::fs::read_to_string(scope.join(swarm_name)).unwrap();
        assert!(swarm.contains("/other/exe"));
    }
}
