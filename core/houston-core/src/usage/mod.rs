//! Token-usage reporting is the third, narrowly granted carve-out from "Houston
//! reads no transcripts": a usage screen IS transcript reading. The bounds any
//! edit must preserve: read-only and on demand, counts only, fail-soft.
pub mod aggregate;
pub mod cache;
pub mod pricing;
pub mod scan;
pub mod time;
pub mod transcripts;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use houston_protocol as proto;

/// The base [`untracked_agents`] subtracts the covered providers from, so the
/// section's "not tracked" list stays derived rather than hand-copied.
pub const TOKEN_SPENDING_AGENTS: [proto::AgentKind; 6] = [
    proto::AgentKind::Claude,
    proto::AgentKind::Codex,
    proto::AgentKind::Antigravity,
    proto::AgentKind::Opencode,
    proto::AgentKind::Cursor,
    proto::AgentKind::Grok,
];

/// Named on the wire so the section can say "not tracked" for these instead of
/// rendering a `0` that reads as "you used nothing" — a lie the operator cannot
/// catch from the screen.
pub fn untracked_agents() -> Vec<proto::AgentKind> {
    let covered: Vec<proto::AgentKind> = proto::UsageProvider::ALL
        .iter()
        .map(|p| p.agent_kind())
        .collect();
    TOKEN_SPENDING_AGENTS
        .into_iter()
        .filter(|kind| !covered.contains(kind))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSpec {
    pub provider: proto::UsageProvider,
    pub root: PathBuf,
    pub profile_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ScanRequest {
    pub since_ms: i64,
    pub until_ms: i64,
    pub refresh_pricing: bool,
    pub state_dir: PathBuf,
    pub sources: Vec<SourceSpec>,
}

#[derive(Debug)]
pub struct ScanOutcome {
    pub buckets: Vec<proto::UsageBucket>,
    pub sources: Vec<proto::UsageSource>,
    pub pricing: proto::UsagePricing,
    pub scan_duration_ms: u64,
    pub duplicates_dropped: u64,
    pub out_of_window: u64,
}

pub fn default_root(provider: proto::UsageProvider, home: &Path) -> PathBuf {
    match provider {
        proto::UsageProvider::Claude => home.join(".claude").join("projects"),
        proto::UsageProvider::Codex => home.join(".codex").join("sessions"),
    }
}

pub fn root_under_config_dir(provider: proto::UsageProvider, config_dir: &Path) -> PathBuf {
    match provider {
        proto::UsageProvider::Claude => config_dir.join("projects"),
        proto::UsageProvider::Codex => config_dir.join("sessions"),
    }
}

fn dedupe_sources(sources: Vec<SourceSpec>) -> Vec<SourceSpec> {
    let mut seen: HashSet<(proto::UsageProvider, PathBuf)> = HashSet::new();
    let mut out = Vec::with_capacity(sources.len());
    for spec in sources {
        let identity = std::fs::canonicalize(&spec.root).unwrap_or_else(|_| spec.root.clone());
        if seen.insert((spec.provider, identity)) {
            out.push(spec);
        }
    }
    out
}

/// Blocking: walks directories, reads files, and may make one HTTP request for
/// the rate table. Callers on the daemon's event loop must run it under
/// `spawn_blocking`.
pub fn scan(request: &ScanRequest) -> ScanOutcome {
    let started = std::time::Instant::now();

    let (rates, pricing) = pricing::load_rate_table(&request.state_dir, request.refresh_pricing);
    let mut cache = cache::ScanCacheDb::open(&request.state_dir);
    let mut cache_dirty = false;

    let mut aggregator = aggregate::Aggregator::new(request.since_ms, request.until_ms, rates);
    let mut sources = Vec::with_capacity(request.sources.len());

    for spec in dedupe_sources(request.sources.clone()) {
        let listing = scan::list_transcripts(&spec.root, request.since_ms);
        let mut scanned_files = 0u32;
        let mut failed_files = 0u32;
        let mut session_ids: HashSet<String> = HashSet::new();

        for file in &listing.files {
            let key = file.path.to_string_lossy().into_owned();
            let records = match cache.lookup(&key, file.size, file.mtime_ms, spec.provider) {
                Some(records) => records,
                None => match scan::read_records(&file.path, spec.provider) {
                    Some(records) => {
                        cache.store(&key, file.size, file.mtime_ms, spec.provider, &records);
                        cache_dirty = true;
                        records
                    }
                    None => {
                        failed_files += 1;
                        continue;
                    }
                },
            };
            scanned_files += 1;

            for record in &records {
                if aggregator.add(record) && !record.session_id.is_empty() {
                    session_ids.insert(record.session_id.clone());
                }
            }
        }

        let (status, message) = source_status(&listing, failed_files, scanned_files, &spec.root);
        sources.push(proto::UsageSource {
            provider: spec.provider,
            path: spec.root.display().to_string(),
            profile_name: spec.profile_name.clone(),
            status,
            scanned_files,
            skipped_files: listing.skipped,
            failed_files,
            distinct_sessions: session_ids.len() as u32,
            message,
        });
    }

    if cache_dirty {
        cache.prune(time::now_ms());
    }
    cache.flush();

    let result = aggregator.finish();
    ScanOutcome {
        buckets: result.buckets,
        sources,
        pricing,
        scan_duration_ms: started.elapsed().as_millis() as u64,
        duplicates_dropped: result.duplicates_dropped,
        out_of_window: result.out_of_window,
    }
}

fn source_status(
    listing: &scan::Listing,
    failed_files: u32,
    scanned_files: u32,
    root: &Path,
) -> (proto::UsageSourceStatus, Option<String>) {
    if !listing.root_exists {
        return (
            proto::UsageSourceStatus::Missing,
            Some(format!("{} does not exist", root.display())),
        );
    }
    if scanned_files == 0 && (failed_files > 0 || listing.unreadable_dirs > 0) {
        return (
            proto::UsageSourceStatus::Failed,
            Some(format!(
                "read nothing under {}: {failed_files} unreadable file(s), \
                 {} unreadable director(ies)",
                root.display(),
                listing.unreadable_dirs
            )),
        );
    }
    if failed_files > 0 || listing.unreadable_dirs > 0 {
        return (
            proto::UsageSourceStatus::Partial,
            Some(format!(
                "{failed_files} unreadable file(s) and {} unreadable director(ies) \
                 under {} are missing from these figures",
                listing.unreadable_dirs,
                root.display()
            )),
        );
    }
    (proto::UsageSourceStatus::Ok, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(path)
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
    }

    fn claude_assistant(id: &str, request: &str, ts: &str, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","sessionId":"s1","requestId":"{request}","message":{{"id":"{id}","model":"claude-opus-5","usage":{{"input_tokens":10,"output_tokens":{output}}}}}}}"#
        )
    }

    fn request(dir: &Path, sources: Vec<SourceSpec>) -> ScanRequest {
        ScanRequest {
            since_ms: 0,
            until_ms: i64::MAX / 2,
            refresh_pricing: false,
            state_dir: dir.to_path_buf(),
            sources,
        }
    }

    #[test]
    fn one_message_written_as_three_content_blocks_counts_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        write(
            &root.join("proj/session.jsonl"),
            &format!(
                "{}\n{}\n{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50),
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50),
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        let out = scan(&request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Claude,
                root: root.clone(),
                profile_name: None,
            }],
        ));
        assert_eq!(out.buckets.len(), 1);
        assert_eq!(out.buckets[0].records, 1);
        assert_eq!(out.buckets[0].totals.output_tokens, 50);
        assert_eq!(out.duplicates_dropped, 2);
        assert_eq!(out.sources[0].status, proto::UsageSourceStatus::Ok);
        assert_eq!(out.sources[0].scanned_files, 1);
        assert_eq!(out.sources[0].distinct_sessions, 1);
    }

    #[test]
    fn the_same_message_copied_into_a_resumed_session_counts_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        let line = claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50);
        write(&root.join("proj/original.jsonl"), &format!("{line}\n"));
        write(&root.join("proj/resumed.jsonl"), &format!("{line}\n"));
        let out = scan(&request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Claude,
                root,
                profile_name: None,
            }],
        ));
        assert_eq!(
            out.buckets[0].records, 1,
            "de-duplication must be global across files, not per file"
        );
        assert_eq!(out.sources[0].scanned_files, 2);
    }

    #[test]
    fn two_profiles_pointing_at_one_directory_are_scanned_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        write(
            &root.join("proj/session.jsonl"),
            &format!(
                "{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        let out = scan(&request(
            dir.path(),
            vec![
                SourceSpec {
                    provider: proto::UsageProvider::Claude,
                    root: root.clone(),
                    profile_name: None,
                },
                SourceSpec {
                    provider: proto::UsageProvider::Claude,
                    root: root.join("..").join("projects"),
                    profile_name: Some("work".into()),
                },
            ],
        ));
        assert_eq!(
            out.sources.len(),
            1,
            "the same directory named twice is one source"
        );
        assert_eq!(out.buckets[0].totals.output_tokens, 50);
    }

    #[test]
    fn distinct_profiles_are_both_scanned_and_both_named() {
        let dir = tempfile::tempdir().unwrap();
        let personal = dir.path().join("home/.claude-personal/projects");
        let work = dir.path().join("home/.claude/projects");
        write(
            &personal.join("p/a.jsonl"),
            &format!(
                "{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        write(
            &work.join("p/b.jsonl"),
            &format!(
                "{}\n",
                claude_assistant("m2", "r2", "2026-08-27T10:00:00Z", 70)
            ),
        );
        let out = scan(&request(
            dir.path(),
            vec![
                SourceSpec {
                    provider: proto::UsageProvider::Claude,
                    root: work,
                    profile_name: None,
                },
                SourceSpec {
                    provider: proto::UsageProvider::Claude,
                    root: personal,
                    profile_name: Some("personal".into()),
                },
            ],
        ));
        assert_eq!(out.sources.len(), 2);
        assert_eq!(out.buckets[0].totals.output_tokens, 120);
        assert_eq!(out.sources[1].profile_name.as_deref(), Some("personal"));
    }

    #[test]
    fn a_home_where_the_cli_never_ran_is_missing_not_failed() {
        let dir = tempfile::tempdir().unwrap();
        let out = scan(&request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Codex,
                root: dir.path().join("home/.codex/sessions"),
                profile_name: None,
            }],
        ));
        assert_eq!(out.sources[0].status, proto::UsageSourceStatus::Missing);
        assert!(out.buckets.is_empty());
        assert!(out.sources[0].message.is_some());
    }

    #[test]
    fn a_second_scan_reuses_the_cache_and_produces_the_same_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        write(
            &root.join("proj/session.jsonl"),
            &format!(
                "{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        let req = request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Claude,
                root,
                profile_name: None,
            }],
        );
        let first = scan(&req);
        assert!(cache::scan_cache_path(dir.path()).exists());
        let second = scan(&req);
        assert_eq!(first.buckets.len(), second.buckets.len());
        assert_eq!(
            first.buckets[0].totals.output_tokens,
            second.buckets[0].totals.output_tokens
        );
        assert_eq!(second.sources[0].scanned_files, 1);
    }

    #[test]
    fn a_scan_that_reparses_nothing_does_not_rewrite_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        write(
            &root.join("proj/session.jsonl"),
            &format!(
                "{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        let req = request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Claude,
                root,
                profile_name: None,
            }],
        );
        scan(&req);
        let cache_path = cache::scan_cache_path(dir.path());
        let first = std::fs::metadata(&cache_path).unwrap().modified().unwrap();

        scan(&req);
        let second = std::fs::metadata(&cache_path).unwrap().modified().unwrap();
        assert_eq!(first, second, "an all-hit scan must not write to the cache");
    }

    #[test]
    fn a_narrow_window_does_not_evict_the_wide_window_s_work() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        write(
            &root.join("proj/old.jsonl"),
            &format!(
                "{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        let spec = SourceSpec {
            provider: proto::UsageProvider::Claude,
            root,
            profile_name: None,
        };
        let wide = request(dir.path(), vec![spec.clone()]);
        let mut narrow = wide.clone();
        narrow.since_ms = wide.until_ms - 60_000;

        scan(&wide);
        let cache_path = cache::scan_cache_path(dir.path());
        let after_wide = std::fs::metadata(&cache_path).unwrap().modified().unwrap();

        scan(&narrow);
        scan(&wide);
        let after_second_wide = std::fs::metadata(&cache_path).unwrap().modified().unwrap();
        assert_eq!(
            after_wide, after_second_wide,
            "the narrow window must not have thrown away what the wide one parsed"
        );
    }

    #[test]
    fn appending_to_a_cached_transcript_invalidates_its_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        let file = root.join("proj/session.jsonl");
        write(
            &file,
            &format!(
                "{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50)
            ),
        );
        let req = request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Claude,
                root,
                profile_name: None,
            }],
        );
        assert_eq!(scan(&req).buckets[0].totals.output_tokens, 50);

        let mut appended = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        appended
            .write_all(
                format!(
                    "{}\n",
                    claude_assistant("m2", "r2", "2026-08-27T10:30:00Z", 70)
                )
                .as_bytes(),
            )
            .unwrap();
        drop(appended);

        let after = scan(&req);
        let total: u64 = after.buckets.iter().map(|b| b.totals.output_tokens).sum();
        assert_eq!(
            total, 120,
            "a grown transcript must be re-read, not served from cache"
        );
    }

    #[test]
    fn the_window_bounds_which_records_land() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("home/.claude/projects");
        write(
            &root.join("proj/session.jsonl"),
            &format!(
                "{}\n{}\n",
                claude_assistant("m1", "r1", "2026-08-27T10:00:00Z", 50),
                claude_assistant("m2", "r2", "2026-08-27T12:00:00Z", 70)
            ),
        );
        let mut req = request(
            dir.path(),
            vec![SourceSpec {
                provider: proto::UsageProvider::Claude,
                root,
                profile_name: None,
            }],
        );
        req.since_ms = time::parse_rfc3339_ms("2026-08-27T11:00:00Z").unwrap();
        req.until_ms = time::parse_rfc3339_ms("2026-08-27T13:00:00Z").unwrap();
        let out = scan(&req);
        assert_eq!(out.buckets.len(), 1);
        assert_eq!(out.buckets[0].totals.output_tokens, 70);
        assert_eq!(out.out_of_window, 1);
    }

    #[test]
    fn untracked_agents_is_derived_from_what_is_covered() {
        let untracked = untracked_agents();
        assert!(!untracked.contains(&proto::AgentKind::Claude));
        assert!(!untracked.contains(&proto::AgentKind::Codex));
        assert!(untracked.contains(&proto::AgentKind::Antigravity));
        assert!(untracked.contains(&proto::AgentKind::Opencode));
        assert!(untracked.contains(&proto::AgentKind::Cursor));
        assert!(untracked.contains(&proto::AgentKind::Grok));
        assert_eq!(untracked.len(), 4);
        assert!(!untracked.contains(&proto::AgentKind::Shell));
        assert!(!untracked.contains(&proto::AgentKind::Ssh));
    }

    #[test]
    fn default_roots_are_the_documented_ones() {
        let home = Path::new("/home/u");
        assert_eq!(
            default_root(proto::UsageProvider::Claude, home),
            Path::new("/home/u/.claude/projects")
        );
        assert_eq!(
            default_root(proto::UsageProvider::Codex, home),
            Path::new("/home/u/.codex/sessions")
        );
        assert_eq!(
            root_under_config_dir(
                proto::UsageProvider::Claude,
                Path::new("/home/u/.claude-personal")
            ),
            Path::new("/home/u/.claude-personal/projects")
        );
    }
}
