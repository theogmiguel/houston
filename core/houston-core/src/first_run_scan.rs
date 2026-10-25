//! First-run workspace discovery: where the agent CLIs already work. Read-only
//! and on demand, in the same carve-out class as the usage scan — it reads only
//! each transcript's recorded `cwd`, since bucket names cannot be reversed.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::host_env::HostEnv;

/// Candidates older than this are skipped: discovery offers where you work now,
/// not an inventory of every folder a CLI ever touched.
pub const SCAN_WINDOW_DAYS: i64 = 90;

/// A session's `cwd` sits in the first few records; a file whose head has none
/// (or is one giant embedded blob) is skipped, not read to the end.
const MAX_LINES_PER_FILE: usize = 64;
const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_transcripts: u32,
    pub max_project_dirs: usize,
    pub max_repo_probes: usize,
    pub max_offers: usize,
    pub budget_ms: u128,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            // Past this the reply says the scan stopped early rather than
            // reading an unbounded history.
            max_transcripts: 2_000,
            // Claude project buckets visited.
            max_project_dirs: 512,
            // A candidate that fails costs one fast `git rev-parse`, so the
            // probe walk itself needs a bound.
            max_repo_probes: 200,
            // Qualifying repositories offered in one reply.
            max_offers: 50,
            // Wall-clock budget, checked between transcript reads.
            budget_ms: 3_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredFolder {
    pub path: String,
    pub last_active_ms: i64,
    pub sessions: u32,
}

#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub folders: Vec<DiscoveredFolder>,
    pub transcripts_read: u32,
    /// The cap that stopped the scan, naming the limit and the value that hit it.
    pub capped: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanRoots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
}

/// The default roots, honouring the CLIs' config-dir overrides the way hook and
/// account reads do. `None` when the daemon has no home directory.
pub fn resolve_roots(env: &HostEnv) -> Option<ScanRoots> {
    let home = env.home_dir()?;
    let claude_config = env
        .var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex_home = env
        .var_os("CODEX_HOME")
        .filter(|v| !v.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    Some(ScanRoots {
        claude_projects: claude_config.join("projects"),
        codex_sessions: codex_home.join("sessions"),
    })
}

fn mtime_ms(path: &Path) -> Option<i64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

#[derive(Default)]
struct Candidates {
    by_identity: HashMap<PathBuf, usize>,
    list: Vec<DiscoveredFolder>,
}

impl Candidates {
    fn add(&mut self, raw: &str, active_ms: i64) {
        let path = Path::new(raw);
        // Windows canonicalisation returns `\\?\`-verbatim paths: fit to tell
        // spellings apart, not to show or to hand to git.
        let identity = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        match self.by_identity.get(&identity) {
            Some(&i) => {
                let seen = &mut self.list[i];
                seen.sessions += 1;
                seen.last_active_ms = seen.last_active_ms.max(active_ms);
            }
            None => {
                self.by_identity.insert(identity, self.list.len());
                self.list.push(DiscoveredFolder {
                    path: raw.to_owned(),
                    last_active_ms: active_ms,
                    sessions: 1,
                });
            }
        }
    }
}

struct Budget {
    start: Instant,
    limits: ScanLimits,
    transcripts_read: u32,
    capped: Option<String>,
}

impl Budget {
    fn new(limits: ScanLimits) -> Self {
        Self {
            start: Instant::now(),
            limits,
            transcripts_read: 0,
            capped: None,
        }
    }

    /// False when the scan must stop; records the cap that stopped it.
    fn charge_transcript(&mut self) -> bool {
        if self.transcripts_read >= self.limits.max_transcripts {
            self.capped = Some(format!(
                "stopped after reading {} session transcripts; folders beyond them may be missing",
                self.limits.max_transcripts
            ));
            return false;
        }
        self.transcripts_read += 1;
        if self.start.elapsed().as_millis() >= self.limits.budget_ms {
            self.capped = Some(format!(
                "stopped after {} ms reading {} session transcripts; \
                 folders beyond them may be missing",
                self.limits.budget_ms, self.transcripts_read
            ));
            return false;
        }
        true
    }
}

/// The first top-level `"cwd"` string in the file's head, or `None`.
fn claude_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::with_capacity(32 * 1024, file);
    for line in reader.lines().take(MAX_LINES_PER_FILE) {
        let Ok(line) = line else { return None };
        if line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(|v| v.as_str()) {
            if !cwd.trim().is_empty() {
                return Some(cwd.to_owned());
            }
        }
    }
    None
}

/// Codex rollouts record the working directory once, in the `session_meta`
/// payload near the head of the file.
fn codex_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::with_capacity(32 * 1024, file);
    for line in reader.lines().take(MAX_LINES_PER_FILE) {
        let Ok(line) = line else { return None };
        if line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
            continue;
        }
        let cwd = value
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !cwd.trim().is_empty() {
            return Some(cwd.to_owned());
        }
    }
    None
}

fn within_window(path: &Path, since_ms: i64) -> bool {
    mtime_ms(path).is_some_and(|m| m >= since_ms)
}

/// Bounded best effort: an unreadable root or bucket contributes nothing
/// instead of failing the reply.
fn collect_roots(
    roots: &ScanRoots,
    since_ms: i64,
    budget: &mut Budget,
    candidates: &mut Candidates,
) {
    let mut buckets = 0usize;
    if let Ok(entries) = std::fs::read_dir(&roots.claude_projects) {
        for bucket in entries.flatten() {
            if buckets >= budget.limits.max_project_dirs {
                budget.capped.get_or_insert_with(|| {
                    format!(
                        "stopped after {} Claude project folders; folders beyond them may be \
                         missing",
                        budget.limits.max_project_dirs
                    )
                });
                break;
            }
            buckets += 1;
            let Ok(files) = std::fs::read_dir(bucket.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if !within_window(&path, since_ms) {
                    continue;
                }
                if !budget.charge_transcript() {
                    return;
                }
                if let Some(cwd) = claude_cwd(&path) {
                    let active = mtime_ms(&path).unwrap_or_default();
                    candidates.add(&cwd, active);
                }
            }
        }
    }
    let mut stack = vec![roots.codex_sessions.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() => {
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    if !within_window(&path, since_ms) {
                        continue;
                    }
                    if !budget.charge_transcript() {
                        return;
                    }
                    if let Some(cwd) = codex_cwd(&path) {
                        let active = mtime_ms(&path).unwrap_or_default();
                        candidates.add(&cwd, active);
                    }
                }
                _ => {}
            }
        }
    }
}

pub fn scan(roots: &ScanRoots, now_ms: i64) -> ScanOutcome {
    scan_with(roots, now_ms, ScanLimits::default())
}

pub fn scan_with(roots: &ScanRoots, now_ms: i64, limits: ScanLimits) -> ScanOutcome {
    let mut budget = Budget::new(limits);
    let mut candidates = Candidates::default();
    let since_ms = now_ms - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
    collect_roots(roots, since_ms, &mut budget, &mut candidates);

    let mut ordered = candidates.list;
    ordered.sort_by(|a, b| {
        b.last_active_ms
            .cmp(&a.last_active_ms)
            .then(a.path.cmp(&b.path))
    });

    let mut folders = Vec::new();
    for (probes, candidate) in ordered.iter().enumerate() {
        if folders.len() >= limits.max_offers {
            budget.capped.get_or_insert_with(|| {
                format!(
                    "offering the {} most recently used folders; older ones are not listed",
                    limits.max_offers
                )
            });
            break;
        }
        if probes >= limits.max_repo_probes {
            budget.capped.get_or_insert_with(|| {
                format!(
                    "stopped after checking {} folders for git repositories; some folders may \
                     be missing",
                    limits.max_repo_probes
                )
            });
            break;
        }
        if Path::new(&candidate.path).is_dir()
            && crate::git::is_git_repo(Path::new(&candidate.path))
        {
            folders.push(candidate.clone());
        }
    }

    ScanOutcome {
        folders,
        transcripts_read: budget.transcripts_read,
        capped: budget.capped,
        duration_ms: budget.start.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use super::*;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn set_mtime(path: &Path, ms: i64) {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    fn git_init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {:?}", out.stderr);
        };
        run(&["init", "-q"]);
        write(&dir.join("f.txt"), "x\n");
        run(&["add", "."]);
        run(&["commit", "-qm", "init"]);
    }

    fn env_with_home(home: &Path) -> HostEnv {
        HostEnv::from_pairs([
            ("HOME", home.to_string_lossy().into_owned()),
            ("USERPROFILE", home.to_string_lossy().into_owned()),
        ])
    }

    /// A path embedded as a JSON string value: backslashes are escapes there.
    fn json_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "\\\\")
    }

    #[test]
    fn roots_follow_the_cli_config_dir_overrides() {
        let env = HostEnv::from_pairs([("CLAUDE_CONFIG_DIR", "/cfg/claude")]);
        let roots = resolve_roots(&env).unwrap();
        assert_eq!(roots.claude_projects, PathBuf::from("/cfg/claude/projects"));
        assert!(
            roots.codex_sessions.ends_with(".codex/sessions"),
            "codex falls back to the home: {:?}",
            roots.codex_sessions
        );
    }

    #[test]
    fn offers_git_repos_newest_first_and_merges_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo_a = tmp.path().join("code/app");
        let repo_b = tmp.path().join("code/lib");
        let scratch = tmp.path().join("scratch");
        git_init(&repo_a);
        git_init(&repo_b);
        std::fs::create_dir_all(&scratch).unwrap();

        let projects = home.join(".claude/projects");
        let a = json_path(&repo_a);
        let b = json_path(&repo_b);
        write(
            &projects.join("bucket-a").join("s1.jsonl"),
            &format!("{{\"type\":\"user\",\"cwd\":\"{a}\"}}\n"),
        );
        write(
            &projects.join("bucket-a").join("s2.jsonl"),
            &format!("{{\"type\":\"user\",\"cwd\":\"{a}\"}}\n"),
        );
        write(
            &projects.join("bucket-b").join("s3.jsonl"),
            &format!("{{\"type\":\"user\",\"cwd\":\"{b}\"}}\n"),
        );
        // A scratch folder the CLIs ran in: never offered.
        write(
            &projects.join("bucket-s").join("s4.jsonl"),
            &format!(
                "{{\"type\":\"user\",\"cwd\":\"{}\"}}\n",
                json_path(&scratch)
            ),
        );
        // A transcript without a cwd in its head: skipped, not fatal.
        write(&projects.join("bucket-n").join("s5.jsonl"), "{\"x\":1}\n");

        let codex = home.join(".codex/sessions/2026/10/24");
        write(
            &codex.join("rollout-1.jsonl"),
            &format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"s\",\"cwd\":\"{a}\"}}}}\n"
            ),
        );

        let now = 1_800_000_000_000i64;
        set_mtime(&projects.join("bucket-b").join("s3.jsonl"), now);
        set_mtime(&projects.join("bucket-a").join("s1.jsonl"), now - 1_000);
        set_mtime(&projects.join("bucket-a").join("s2.jsonl"), now - 2_000);
        set_mtime(&codex.join("rollout-1.jsonl"), now - 3_000);

        let roots = resolve_roots(&env_with_home(&home)).unwrap();
        let outcome = scan(&roots, now);
        assert_eq!(outcome.capped, None, "a small history hits no cap");
        assert_eq!(outcome.folders.len(), 2);
        assert_eq!(outcome.folders[0].path, repo_b.to_string_lossy());
        assert_eq!(outcome.folders[0].sessions, 1);
        assert_eq!(outcome.folders[1].path, repo_a.to_string_lossy());
        assert_eq!(outcome.folders[1].sessions, 3, "two Claude + one Codex");
        assert_eq!(outcome.folders[1].last_active_ms, now - 1_000);
        assert_eq!(outcome.transcripts_read, 6, "five Claude + one Codex");
    }

    #[test]
    fn a_folder_that_no_longer_exists_is_not_offered() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let projects = home.join(".claude/projects");
        write(
            &projects.join("gone").join("s.jsonl"),
            "{\"cwd\":\"Z:\\\\no-such-dir-7Q\"}\n",
        );
        let roots = resolve_roots(&env_with_home(&home)).unwrap();
        let outcome = scan(&roots, 1_800_000_000_000);
        assert!(outcome.folders.is_empty());
    }

    #[test]
    fn transcripts_older_than_the_window_are_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = tmp.path().join("code/old");
        git_init(&repo);
        let projects = home.join(".claude/projects");
        let path = projects.join("old").join("s.jsonl");
        write(&path, &format!("{{\"cwd\":\"{}\"}}\n", json_path(&repo)));
        let now = 1_800_000_000_000i64;
        set_mtime(&path, now - (SCAN_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1_000);
        let roots = resolve_roots(&env_with_home(&home)).unwrap();
        let outcome = scan(&roots, now);
        assert!(outcome.folders.is_empty());
        assert_eq!(outcome.transcripts_read, 0);
    }

    #[test]
    fn a_transcript_cap_stops_the_scan_and_is_named() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = tmp.path().join("code/app");
        git_init(&repo);
        let projects = home.join(".claude/projects");
        let body = format!("{{\"cwd\":\"{}\"}}\n", json_path(&repo));
        for i in 0..40 {
            write(&projects.join("b").join(format!("s{i}.jsonl")), &body);
        }
        let roots = ScanRoots {
            claude_projects: projects,
            codex_sessions: home.join(".codex/sessions"),
        };
        let outcome = scan_with(
            &roots,
            1_800_000_000_000,
            ScanLimits {
                max_transcripts: 10,
                ..ScanLimits::default()
            },
        );
        let cap = outcome.capped.expect("the cap names itself");
        assert!(
            cap.contains("session transcripts") && cap.contains("may be missing"),
            "cap names the limit and the consequence: {cap}"
        );
        assert_eq!(outcome.transcripts_read, 10);
        assert_eq!(outcome.folders.len(), 1);
    }

    #[test]
    fn an_offer_cap_lists_the_newest_and_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let old = tmp.path().join("code/older");
        let new = tmp.path().join("code/newer");
        git_init(&old);
        git_init(&new);
        let projects = home.join(".claude/projects");
        let now = 1_800_000_000_000i64;
        for (bucket, repo, at) in [
            ("b-old", old.as_os_str(), now - 1_000),
            ("b-new", new.as_os_str(), now),
        ] {
            let path = projects.join(bucket).join("s.jsonl");
            write(
                &path,
                &format!("{{\"cwd\":\"{}\"}}\n", json_path(Path::new(repo))),
            );
            set_mtime(&path, at);
        }
        let roots = ScanRoots {
            claude_projects: projects,
            codex_sessions: home.join(".codex/sessions"),
        };
        let outcome = scan_with(
            &roots,
            now,
            ScanLimits {
                max_offers: 1,
                ..ScanLimits::default()
            },
        );
        assert_eq!(outcome.folders.len(), 1);
        assert_eq!(outcome.folders[0].path, new.to_string_lossy());
        let cap = outcome.capped.expect("the offer cap is reported");
        assert!(cap.contains("most recently used folders"), "{cap}");
    }

    #[test]
    fn no_cap_is_reported_when_every_candidate_was_offered() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = tmp.path().join("code/solo");
        git_init(&repo);
        let projects = home.join(".claude/projects");
        let path = projects.join("b").join("s.jsonl");
        write(&path, &format!("{{\"cwd\":\"{}\"}}\n", json_path(&repo)));
        let roots = ScanRoots {
            claude_projects: projects,
            codex_sessions: home.join(".codex/sessions"),
        };
        let outcome = scan_with(
            &roots,
            1_800_000_000_000,
            ScanLimits {
                max_offers: 1,
                ..ScanLimits::default()
            },
        );
        assert_eq!(outcome.folders.len(), 1);
        assert_eq!(outcome.capped, None, "one repo is the whole history here");
    }
}
