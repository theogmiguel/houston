use anyhow::{bail, Context, Result};
use houston_protocol as proto;
use std::path::{Path, PathBuf};

const PATCH_CAP_BYTES: usize = 512 * 1024;

fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    base.starts_with(".env")
        || lower.contains("credentials")
        || lower.contains("secrets")
        || base.ends_with(".pem")
        || base.ends_with(".key")
        || base.ends_with(".p12")
        || base.starts_with("id_rsa")
}

pub fn status(dir: &Path) -> Result<Vec<proto::GitFileStatus>> {
    ensure_repo(dir)?;
    let raw = run_git(dir, &["status", "--porcelain=v1", "-z"])?;

    let mut files = Vec::new();
    let mut tokens = raw.split('\0').filter(|t| !t.is_empty());
    while let Some(entry) = tokens.next() {
        let bytes = entry.as_bytes();
        if bytes.len() < 4 {
            bail!("unparseable git status entry {entry:?}: expected \"XY <path>\"");
        }
        let (x, y) = (bytes[0], bytes[1]);
        let path = &entry[3..];
        if x == b'R' || y == b'R' || x == b'C' || y == b'C' {
            tokens.next();
        }
        let is_sensitive = is_sensitive_path(path);
        for (status, staged) in split_state(x, y) {
            files.push(proto::GitFileStatus {
                path: path.to_string(),
                status,
                staged,
                added: None,
                deleted: None,
                is_sensitive,
            });
        }
    }

    merge_numstat(dir, &mut files, true);
    merge_numstat(dir, &mut files, false);
    Ok(files)
}

fn split_state(x: u8, y: u8) -> Vec<(proto::GitFileState, bool)> {
    use proto::GitFileState::*;
    if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
        return vec![(Conflicted, false)];
    }
    if x == b'?' && y == b'?' {
        return vec![(Untracked, false)];
    }
    let mut out = Vec::new();
    match x {
        b'M' | b'T' => out.push((Modified, true)),
        b'A' | b'C' => out.push((Added, true)),
        b'D' => out.push((Deleted, true)),
        b'R' => out.push((Renamed, true)),
        _ => {}
    }
    match y {
        b'M' | b'T' => out.push((Modified, false)),
        b'D' => out.push((Deleted, false)),
        b'R' => out.push((Renamed, false)),
        _ => {}
    }
    out
}

fn merge_numstat(dir: &Path, files: &mut [proto::GitFileStatus], staged: bool) {
    let args: &[&str] = if staged {
        &["diff", "--cached", "--numstat"]
    } else {
        &["diff", "--numstat"]
    };
    let Ok(numstat) = run_git(dir, args) else {
        return;
    };
    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let Some(f) = files.iter_mut().find(|f| f.staged == staged && f.path == p) {
            f.added = a.trim().parse().ok();
            f.deleted = d.trim().parse().ok();
        }
    }
}

pub struct DiffResult {
    pub patch: String,
    pub truncated: bool,
}

pub fn diff(dir: &Path, path: Option<&str>, base: Option<&str>) -> Result<DiffResult> {
    ensure_repo(dir)?;
    if let Some(p) = path {
        if is_sensitive_path(p) {
            return Ok(DiffResult {
                patch: String::new(),
                truncated: false,
            });
        }
    }
    let untracked = list_untracked(dir)?;

    let mut patch = String::new();
    if let Some(b) = base {
        let mb = merge_base(dir, b)?;
        let range = format!("{mb}..HEAD");
        match path {
            Some(p) => patch.push_str(&run_git(dir, &["diff", &range, "--", p])?),
            None => patch.push_str(&run_git(dir, &["diff", &range])?),
        }
    }
    match path {
        Some(p) => {
            if untracked.iter().any(|u| u == p) {
                patch.push_str(&untracked_diff(dir, p)?);
            } else {
                patch.push_str(&run_git(dir, &["diff", "HEAD", "--", p])?);
            }
        }
        None => {
            patch.push_str(&run_git(dir, &["diff", "HEAD"])?);
            for p in &untracked {
                patch.push_str(&untracked_diff(dir, p)?);
            }
        }
    }

    let truncated = patch.len() > PATCH_CAP_BYTES;
    if truncated {
        let mut cut = PATCH_CAP_BYTES;
        while !patch.is_char_boundary(cut) {
            cut -= 1;
        }
        patch.truncate(cut);
    }
    Ok(DiffResult { patch, truncated })
}

fn cap_patch(mut patch: String) -> (String, bool) {
    let truncated = patch.len() > PATCH_CAP_BYTES;
    if truncated {
        let mut cut = PATCH_CAP_BYTES;
        while !patch.is_char_boundary(cut) {
            cut -= 1;
        }
        patch.truncate(cut);
    }
    (patch, truncated)
}

fn split_patch_by_file(patch: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut a_path = String::new();
    let mut b_path = String::new();
    for line in patch.split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if !current.is_empty() {
                out.push((a_path.clone(), b_path.clone(), current.join("\n")));
            }
            current = Vec::new();
            match rest.split_once(" b/") {
                Some((a, b)) => {
                    a_path = a.strip_prefix("a/").unwrap_or(a).to_string();
                    b_path = b.to_string();
                }
                None => {
                    a_path = rest.to_string();
                    b_path = rest.to_string();
                }
            }
        }
        current.push(line);
    }
    if !current.is_empty() {
        out.push((a_path, b_path, current.join("\n")));
    }
    out
}

fn exclude_sensitive_files(patch: &str) -> String {
    split_patch_by_file(patch)
        .into_iter()
        .filter(|(a, b, _)| !is_sensitive_path(a) && !is_sensitive_path(b))
        .map(|(_, _, chunk)| chunk)
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_review_section(raw: String) -> (String, bool) {
    let (capped, truncated) = cap_patch(raw);
    (exclude_sensitive_files(&capped), truncated)
}

fn redact_review_patch(patch: &str) -> (String, bool) {
    crate::sanitize::redact_review_secrets(patch)
}

/// Cap, drop sensitive-file chunks, and redact secret-shaped values. Every
/// patch Houston prints or hands to a model goes through this one pipeline.
pub fn sanitized_patch(raw: String) -> (String, bool, bool) {
    let (capped, truncated) = cap_patch(raw);
    let filtered = exclude_sensitive_files(&capped);
    let (patch, redacted) = redact_review_patch(&filtered);
    (patch, truncated, redacted)
}

pub struct ReviewDiffs {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub head: Option<String>,
    pub files: Vec<proto::GitFileStatus>,
    pub sections: Vec<proto::GitReviewSection>,
    pub blocked_paths: Vec<String>,
    pub warnings: Vec<String>,
    pub truncated: bool,
    pub redacted: bool,
}

pub fn review_diffs(dir: &Path) -> Result<ReviewDiffs> {
    ensure_repo(dir)?;
    let files = status(dir)?;
    let sync_status = sync(dir);
    let head = head_sha(dir).ok();

    let mut warnings = Vec::new();
    if head.is_none() {
        warnings.push(
            "This repository has no commits yet — staged/unstaged diffs below are shown \
             against an empty tree, not real history."
                .to_string(),
        );
    }

    let mut blocked_paths: Vec<String> = files
        .iter()
        .filter(|f| f.is_sensitive)
        .map(|f| f.path.clone())
        .collect();
    blocked_paths.sort();
    blocked_paths.dedup();

    let mut sections = Vec::new();
    let mut truncated = false;
    let mut redacted = false;

    let staged_raw = run_git(dir, &["diff", "--cached"])?;
    let (staged_patch, t) = build_review_section(staged_raw);
    truncated |= t;
    let (staged_patch, r) = redact_review_patch(&staged_patch);
    redacted |= r;
    if !staged_patch.is_empty() {
        sections.push(proto::GitReviewSection {
            scope: proto::GitReviewScope::Staged,
            patch: staged_patch,
        });
    }

    let unstaged_raw = run_git(dir, &["diff"])?;
    let (unstaged_patch, t) = build_review_section(unstaged_raw);
    truncated |= t;
    let (unstaged_patch, r) = redact_review_patch(&unstaged_patch);
    redacted |= r;
    if !unstaged_patch.is_empty() {
        sections.push(proto::GitReviewSection {
            scope: proto::GitReviewScope::Unstaged,
            patch: unstaged_patch,
        });
    }

    let untracked = list_untracked(dir)?;
    let mut untracked_raw = String::new();
    for p in &untracked {
        if is_sensitive_path(p) {
            continue;
        }
        untracked_raw.push_str(&untracked_diff(dir, p)?);
    }
    let (untracked_patch, t) = cap_patch(untracked_raw);
    truncated |= t;
    let (untracked_patch, r) = redact_review_patch(&untracked_patch);
    redacted |= r;
    if !untracked_patch.is_empty() {
        sections.push(proto::GitReviewSection {
            scope: proto::GitReviewScope::Untracked,
            patch: untracked_patch,
        });
    }

    Ok(ReviewDiffs {
        branch: sync_status.branch,
        upstream: sync_status.upstream,
        ahead: sync_status.ahead,
        behind: sync_status.behind,
        head,
        files,
        sections,
        blocked_paths,
        warnings,
        truncated,
        redacted,
    })
}

pub fn head_sha(dir: &Path) -> Result<String> {
    Ok(run_git(dir, &["rev-parse", "HEAD"])?.trim().to_string())
}

/// The staged patch through the cap/exclude/redact pipeline — what a
/// commit-message suggestion is written from. Nothing unstaged leaks in.
pub fn staged_patch(dir: &Path) -> Result<(String, bool, bool)> {
    ensure_repo(dir)?;
    Ok(sanitized_patch(run_git(dir, &["diff", "--cached"])?))
}

pub struct BranchContext {
    pub branch: Option<String>,
    pub base: String,
    pub commits: Vec<String>,
    pub patch: String,
    pub truncated: bool,
    pub redacted: bool,
}

/// What a PR title/body suggestion is written from: the commit list and the
/// committed diff between the merge base and HEAD. Capped at 50 subjects — a
/// body is a summary, and the patch itself carries the rest.
pub fn branch_context(dir: &Path, base: Option<&str>) -> Result<BranchContext> {
    ensure_repo(dir)?;
    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => default_base(dir).with_context(|| {
            format!(
                "{} has no default branch to diff against; expected main, master, or origin/HEAD",
                dir.display()
            )
        })?,
    };
    let mb = merge_base(dir, &base)?;
    let range = format!("{mb}..HEAD");
    let log = run_git(dir, &["log", "--oneline", "--no-decorate", &range])?;
    let commits: Vec<String> = log
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(50)
        .map(str::to_string)
        .collect();
    let raw = run_git(dir, &["diff", &range])?;
    let (patch, truncated, redacted) = sanitized_patch(raw);
    Ok(BranchContext {
        branch: sync(dir).branch,
        base,
        commits,
        patch,
        truncated,
        redacted,
    })
}

pub fn branch(dir: &Path) -> Option<String> {
    if !dir.is_dir() {
        return None;
    }
    let head = head_file(dir).and_then(|h| std::fs::read(h).ok());
    match head {
        Some(bytes) => branch_via_cache(dir, bytes, || branch_uncached(dir)),
        None => branch_uncached(dir),
    }
}

fn branch_uncached(dir: &Path) -> Option<String> {
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() || name == "HEAD" {
        None
    } else {
        Some(name)
    }
}

const BRANCH_CACHE_MAX: usize = 64;

type BranchEntry = (Vec<u8>, Option<String>);

static BRANCH_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, BranchEntry>>,
> = std::sync::LazyLock::new(Default::default);

fn branch_via_cache(
    dir: &Path,
    head: Vec<u8>,
    compute: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Ok(cache) = BRANCH_CACHE.lock() {
        if let Some((cached_head, answer)) = cache.get(dir) {
            if *cached_head == head {
                return answer.clone();
            }
        }
    }
    let fresh = compute();
    if let Ok(mut cache) = BRANCH_CACHE.lock() {
        if cache.len() >= BRANCH_CACHE_MAX && !cache.contains_key(dir) {
            cache.clear();
        }
        cache.insert(dir.to_path_buf(), (head, fresh.clone()));
    }
    fresh
}

fn head_file(dir: &Path) -> Option<std::path::PathBuf> {
    for ancestor in dir.ancestors() {
        let dot_git = ancestor.join(".git");
        let Ok(meta) = std::fs::metadata(&dot_git) else {
            continue;
        };
        if meta.is_dir() {
            return Some(dot_git.join("HEAD"));
        }
        if meta.is_file() {
            let contents = std::fs::read_to_string(&dot_git).ok()?;
            let target = contents.split_once("gitdir:")?.1.trim();
            if target.is_empty() {
                return None;
            }
            let target = Path::new(target);
            let git_dir = if target.is_absolute() {
                target.to_path_buf()
            } else {
                ancestor.join(target)
            };
            return Some(git_dir.join("HEAD"));
        }
    }
    None
}

#[derive(Debug, Default, Clone)]
pub struct SyncStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

pub fn sync(dir: &Path) -> SyncStatus {
    let mut s = SyncStatus::default();
    let Ok(out) = run_git(
        dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=no",
        ],
    ) else {
        return s;
    };
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("# branch.head ") {
            if v != "(detached)" {
                s.branch = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("# branch.upstream ") {
            s.upstream = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("# branch.ab ") {
            for tok in v.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        }
    }
    s
}

pub fn stage(dir: &Path, paths: &[String]) -> Result<()> {
    ensure_repo(dir)?;
    if paths.is_empty() {
        run_git(dir, &["add", "-A"])?;
    } else {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git(dir, &args)?;
    }
    Ok(())
}

pub fn unstage(dir: &Path, paths: &[String]) -> Result<()> {
    ensure_repo(dir)?;
    if run_git(dir, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        let mut args = vec!["reset", "-q"];
        if !paths.is_empty() {
            args.push("--");
            args.extend(paths.iter().map(String::as_str));
        }
        run_git(dir, &args)?;
    } else {
        let all = [String::from(".")];
        let targets: &[String] = if paths.is_empty() { &all } else { paths };
        let mut args = vec!["rm", "--cached", "-q", "-r", "--"];
        args.extend(targets.iter().map(String::as_str));
        run_git(dir, &args)?;
    }
    Ok(())
}

#[derive(Debug)]
pub struct CommitResult {
    pub sha: String,
    pub summary: String,
}

pub fn commit(dir: &Path, message: &str) -> Result<CommitResult> {
    ensure_repo(dir)?;
    let msg = message.trim();
    if msg.is_empty() {
        bail!("refusing to commit with an empty message");
    }
    let out = run_git(dir, &["commit", "-m", msg])?;
    let sha = run_git(dir, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string();
    let summary = out.lines().next().unwrap_or("").trim().to_string();
    Ok(CommitResult { sha, summary })
}

/// Pushes the current branch: a branch with no upstream is published via `-u`,
/// and an upstream that is really the branch's base (what `checkout -b feature
/// origin/dev` leaves) is retargeted. `GIT_TERMINAL_PROMPT=0` fails fast.
pub fn push(dir: &Path) -> Result<String> {
    ensure_repo(dir)?;
    let sync = sync(dir);
    let Some(branch) = sync.branch.clone() else {
        bail!("cannot push from a detached HEAD; check out a branch first");
    };
    let mut args: Vec<String> = vec!["push".to_string()];
    if let Some(upstream) = sync.upstream.as_deref() {
        let upstream_branch = upstream.split_once('/').map(|(_, b)| b).unwrap_or(upstream);
        let is_own_upstream = upstream_branch == branch
            || (branch.ends_with(&format!("/{upstream_branch}"))
                && upstream.ends_with(&format!("/{branch}")));
        if !is_own_upstream {
            let Some(remote) = remote_name(dir) else {
                bail!(
                    "{} has no git remote; add one (git remote add origin <url>) before pushing",
                    dir.display()
                );
            };
            args.push("-u".to_string());
            args.push(remote);
        }
    } else {
        let Some(remote) = remote_name(dir) else {
            bail!(
                "{} has no git remote; add one (git remote add origin <url>) before pushing",
                dir.display()
            );
        };
        args.push("-u".to_string());
        args.push(remote);
    }
    if args.len() > 2 {
        args.push(format!("HEAD:refs/heads/{branch}"));
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .with_context(|| format!("spawning git push in {}", dir.display()))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        bail!(
            "git push in {} failed (exit {:?}): {}",
            dir.display(),
            out.status.code(),
            stderr.trim()
        );
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let summary = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("pushed")
        .to_string();
    Ok(summary)
}

fn ensure_discardable(dir: &Path, path: &str) -> Result<()> {
    if path.is_empty() {
        bail!("git_discard: empty path; expected a repo-relative path such as \"src/main.rs\"");
    }
    if Path::new(path).is_absolute() {
        bail!(
            "git_discard: path {path:?} is absolute; expected a path relative to the repo root {}",
            dir.display()
        );
    }
    if path.split('/').any(|seg| seg == "..") {
        bail!(
            "git_discard: path {path:?} contains a \"..\" segment and could escape the repo root {}; expected a plain repo-relative path",
            dir.display()
        );
    }
    if is_sensitive_path(path) {
        bail!(
            "git_discard: refusing to discard {path:?} — it matches the sensitive-file rule, and its contents were never shown in the pane"
        );
    }
    Ok(())
}

pub fn discard(dir: &Path, path: &str, kind: proto::GitDiscardKind) -> Result<()> {
    ensure_repo(dir)?;
    ensure_discardable(dir, path)?;
    match kind {
        proto::GitDiscardKind::Staged => {
            run_git(dir, &["restore", "--staged", "--worktree", "--", path])?;
        }
        proto::GitDiscardKind::Unstaged => {
            run_git(dir, &["restore", "--", path])?;
        }
        proto::GitDiscardKind::Untracked => {
            let full = dir.join(path);
            if full.is_dir() {
                std::fs::remove_dir_all(&full)
                    .with_context(|| format!("deleting untracked directory {}", full.display()))?;
            } else {
                std::fs::remove_file(&full)
                    .with_context(|| format!("deleting untracked file {}", full.display()))?;
            }
        }
    }
    Ok(())
}

pub fn default_base(dir: &Path) -> Option<String> {
    if let Ok(out) = run_git(
        dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        let t = out.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    for candidate in ["main", "master"] {
        if run_git(dir, &["rev-parse", "--verify", "--quiet", candidate]).is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn merge_base(dir: &Path, base: &str) -> Result<String> {
    let out = run_git(dir, &["merge-base", base, "HEAD"]).with_context(|| {
        format!("git_status/git_diff: no merge base between {base:?} and HEAD; expected a branch or ref that exists in this repo")
    })?;
    let t = out.trim().to_string();
    if t.is_empty() {
        bail!(
            "git_status/git_diff: merge-base of {base:?} and HEAD is empty; expected a commit sha"
        );
    }
    Ok(t)
}

pub fn status_vs_base(dir: &Path, base: &str) -> Result<Vec<proto::GitFileStatus>> {
    ensure_repo(dir)?;
    let mb = merge_base(dir, base)?;
    let raw = run_git(dir, &["diff", "--numstat", "-z", &format!("{mb}..HEAD")])?;
    let mut out: Vec<proto::GitFileStatus> = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(rec) = it.next() {
        let mut parts = rec.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = it.next();
            match it.next() {
                Some(new) => new.to_string(),
                None => continue,
            }
        } else {
            path.to_string()
        };
        out.push(proto::GitFileStatus {
            is_sensitive: is_sensitive_path(&path),
            path,
            status: proto::GitFileState::Modified,
            staged: true,
            added: add.parse::<i64>().ok(),
            deleted: del.parse::<i64>().ok(),
        });
    }
    out.extend(status(dir)?);
    Ok(out)
}

pub fn ref_slug(raw: &str) -> String {
    // Keep generated branch and directory segments short enough for nested paths.
    const MAX_CHARS: usize = 60;
    let mut slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    slug.truncate(MAX_CHARS);
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "x".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn remote_name(dir: &Path) -> Option<String> {
    let out = run_git(dir, &["remote"]).ok()?;
    let names: Vec<&str> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if names.contains(&"origin") {
        return Some("origin".to_string());
    }
    names.first().map(|n| n.to_string())
}

pub fn remote_url(dir: &Path) -> Option<String> {
    let name = remote_name(dir)?;
    let out = run_git(dir, &["remote", "get-url", &name]).ok()?;
    let url = out.trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

pub fn is_git_repo(dir: &Path) -> bool {
    dir.is_dir() && run_git(dir, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

pub fn worktree_add(repo: &Path, dest: &Path) -> Result<PathBuf> {
    ensure_repo(repo)?;
    if dest.exists() {
        bail!(
            "worktree target already exists: {} (a run gets a fresh directory)",
            dest.display()
        );
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let dest_str = dest
        .to_str()
        .with_context(|| format!("worktree path is not UTF-8: {}", dest.display()))?;
    run_git(repo, &["worktree", "add", "--detach", dest_str, "HEAD"])?;
    Ok(dest.to_path_buf())
}

// T3 caps a ref listing at 200 (`GIT_LIST_BRANCHES_MAX_LIMIT`); a kernel-sized
// remote would otherwise put thousands of rows on one control message.
const BRANCH_LIST_CAP: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub is_default: bool,
    pub is_remote: bool,
    pub remote_name: Option<String>,
    pub upstream: Option<String>,
    pub worktree_path: Option<String>,
}

pub struct BranchList {
    pub branches: Vec<BranchInfo>,
    pub remotes: Vec<BranchInfo>,
    pub default_branch: Option<String>,
    pub truncated: bool,
}

pub fn list_branches(dir: &Path) -> Result<BranchList> {
    ensure_repo(dir)?;
    let default_branch = default_branch_name(dir);
    let mut worktree_paths: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Ok(list) = crate::worktrees::list(dir) {
        for wt in list {
            if let Some(branch) = wt.branch {
                worktree_paths.insert(branch, wt.path.display().to_string());
            }
        }
    }

    let raw = run_git(
        dir,
        &[
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)",
        ],
    )?;
    let mut branches = Vec::new();
    let mut truncated = false;
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(name), Some(head), upstream) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if branches.len() >= BRANCH_LIST_CAP {
            truncated = true;
            break;
        }
        let upstream = upstream.map(str::trim).filter(|u| !u.is_empty());
        branches.push(BranchInfo {
            name: name.to_string(),
            current: head.trim() == "*",
            is_default: default_branch.as_deref() == Some(name),
            is_remote: false,
            remote_name: None,
            upstream: upstream.map(str::to_string),
            worktree_path: worktree_paths.get(name).cloned(),
        });
    }

    let remote_names = remote_names(dir);
    let raw = run_git(
        dir,
        &["for-each-ref", "refs/remotes", "--format=%(refname:short)"],
    )?;
    let mut remotes = Vec::new();
    for line in raw.lines() {
        let name = line.trim();
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        if remotes.len() >= BRANCH_LIST_CAP {
            truncated = true;
            break;
        }
        let remote_name = remote_names
            .iter()
            .find(|r| name.starts_with(&format!("{r}/")))
            .cloned()
            .or_else(|| name.split_once('/').map(|(r, _)| r.to_string()));
        remotes.push(BranchInfo {
            name: name.to_string(),
            current: false,
            is_default: default_branch
                .as_deref()
                .is_some_and(|d| name.ends_with(&format!("/{d}"))),
            is_remote: true,
            remote_name,
            upstream: None,
            worktree_path: None,
        });
    }

    Ok(BranchList {
        branches,
        remotes,
        default_branch,
        truncated,
    })
}

fn default_branch_name(dir: &Path) -> Option<String> {
    let full = default_base(dir)?;
    let remotes = remote_names(dir);
    for remote in remotes {
        if let Some(stripped) = full.strip_prefix(&format!("{remote}/")) {
            return Some(stripped.to_string());
        }
    }
    Some(full)
}

fn remote_names(dir: &Path) -> Vec<String> {
    run_git(dir, &["remote"])
        .map(|raw| {
            raw.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// A branch name is an argument to `git` on the way in; `check-ref-format`
/// both rejects shell-hostile shapes and keeps `-flag`-looking names out.
pub fn validate_branch_name(name: &str) -> Result<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("branch name is empty; expected a name like \"feat/thing\"");
    }
    if trimmed != name {
        bail!("branch name {name:?} has leading or trailing whitespace; expected no whitespace around it");
    }
    if trimmed.starts_with('-') {
        bail!("branch name {name:?} starts with '-'; expected a name git will not read as a flag");
    }
    let ok = crate::spawn::command("git")
        .args(["check-ref-format", "--branch", trimmed])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);
    if !ok {
        bail!("branch name {name:?} is not a valid git branch name (see git check-ref-format)");
    }
    Ok(())
}

pub fn branch_exists(dir: &Path, name: &str) -> bool {
    run_git(
        dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
    )
    .is_ok()
}

pub fn create_branch(dir: &Path, name: &str, base: Option<&str>, switch: bool) -> Result<String> {
    ensure_repo(dir)?;
    validate_branch_name(name)?;
    if branch_exists(dir, name) {
        bail!("branch {name:?} already exists; pick another name or switch to it");
    }
    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if let Some(b) = base {
        rev_parse_commit(dir, b).with_context(|| {
            format!("base ref {b:?} does not resolve to a commit; expected an existing branch, tag or sha")
        })?;
    }
    let mut args = vec!["branch", "--", name];
    if let Some(b) = base {
        args.push(b);
    }
    run_git(dir, &args)?;
    if switch {
        switch_branch(dir, name)?;
    }
    Ok(name.to_string())
}

pub fn switch_branch(dir: &Path, name: &str) -> Result<String> {
    ensure_repo(dir)?;
    validate_branch_name(name)?;
    let local = branch_exists(dir, name);
    let remote = run_git(
        dir,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{name}"),
        ],
    )
    .is_ok();
    if !local && !remote {
        bail!(
            "no branch {name:?} here; expected a local branch or a remote-tracking ref such as origin/{name}"
        );
    }
    let args: Vec<String> = if local {
        vec!["checkout".to_string(), name.to_string()]
    } else if let Some(tracking) = local_branch_tracking(dir, name) {
        vec!["checkout".to_string(), tracking]
    } else {
        vec![
            "checkout".to_string(),
            "--track".to_string(),
            name.to_string(),
        ]
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(dir, &args).with_context(|| {
        format!(
            "git checkout {name:?} was refused (uncommitted changes that would be \
             overwritten, or a checkout conflict); commit or stash them first"
        )
    })?;
    Ok(branch_uncached(dir).unwrap_or_else(|| name.to_string()))
}

fn local_branch_tracking(dir: &Path, upstream: &str) -> Option<String> {
    let raw = run_git(
        dir,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(upstream:short)",
            "refs/heads",
        ],
    )
    .ok()?;
    for line in raw.lines() {
        let (name, up) = line.split_once('\t')?;
        if up.trim() == upstream {
            return Some(name.to_string());
        }
    }
    None
}

pub fn rename_branch(dir: &Path, from: &str, to: &str) -> Result<String> {
    ensure_repo(dir)?;
    validate_branch_name(to)?;
    if from == to {
        return Ok(to.to_string());
    }
    if !branch_exists(dir, from) {
        bail!("branch {from:?} does not exist; expected a local branch to rename");
    }
    if branch_exists(dir, to) {
        bail!("branch {to:?} already exists; pick a name that is free");
    }
    run_git(dir, &["branch", "-m", "--", from, to])?;
    Ok(to.to_string())
}

pub fn delete_branch(dir: &Path, name: &str, force: bool) -> Result<()> {
    ensure_repo(dir)?;
    validate_branch_name(name)?;
    if !branch_exists(dir, name) {
        bail!("branch {name:?} does not exist; nothing to delete");
    }
    if branch_uncached(dir).as_deref() == Some(name) {
        bail!("branch {name:?} is the current branch; switch away before deleting it");
    }
    if let Ok(list) = crate::worktrees::list(dir) {
        if let Some(wt) = list
            .into_iter()
            .find(|wt| wt.branch.as_deref() == Some(name))
        {
            bail!(
                "branch {name:?} is checked out in the worktree {}; remove that worktree first",
                wt.path.display()
            );
        }
    }
    if force {
        run_git(dir, &["branch", "-D", "--", name])?;
    } else {
        run_git(dir, &["branch", "-d", "--", name]).with_context(|| {
            format!("branch {name:?} is not fully merged; merge it first, or delete it with force")
        })?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullStatus {
    Pulled,
    UpToDate,
}

#[derive(Debug)]
pub struct PullOutcome {
    pub status: PullStatus,
    pub branch: String,
    pub upstream: Option<String>,
}

pub fn pull(dir: &Path) -> Result<PullOutcome> {
    ensure_repo(dir)?;
    let sync = sync(dir);
    let Some(branch) = sync.branch.clone() else {
        bail!("cannot pull from a detached HEAD; check out a branch with an upstream first");
    };
    let Some(upstream) = sync.upstream.clone() else {
        bail!(
            "branch {branch:?} has no upstream configured; push it once (which sets the upstream) before pulling"
        );
    };
    let before = head_sha(dir).unwrap_or_default();
    pull_ff_only(dir).with_context(|| {
        format!(
            "git pull --ff-only for {branch:?} from {upstream:?} was refused; the local branch \
             and its upstream have diverged — merge or rebase by hand first"
        )
    })?;
    let after = head_sha(dir).unwrap_or_default();
    Ok(PullOutcome {
        status: if before == after {
            PullStatus::UpToDate
        } else {
            PullStatus::Pulled
        },
        branch,
        upstream: Some(upstream),
    })
}

fn pull_ff_only(dir: &Path) -> Result<String> {
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(["pull", "--ff-only"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .with_context(|| format!("spawning git pull in {}", dir.display()))?;
    if !out.status.success() {
        bail!(
            "git pull in {} failed (exit {:?}): {}",
            dir.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn fetch(dir: &Path) -> Result<String> {
    ensure_repo(dir)?;
    let Some(remote) = remote_name(dir) else {
        bail!(
            "{} has no git remote; add one (git remote add origin <url>) before fetching",
            dir.display()
        );
    };
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(["fetch", "--prune", &remote])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .with_context(|| format!("spawning git fetch in {}", dir.display()))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        bail!(
            "git fetch {remote} in {} failed (exit {:?}): {}",
            dir.display(),
            out.status.code(),
            stderr.trim()
        );
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let summary = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("fetched");
    Ok(summary.to_string())
}

fn rev_parse_commit(dir: &Path, name: &str) -> Result<String> {
    let spec = format!("{name}^{{commit}}");
    let out = run_git(dir, &["rev-parse", "--verify", "--quiet", &spec])?;
    let sha = out.trim().to_string();
    if sha.is_empty() {
        bail!("ref {name:?} resolved to nothing; expected a commit");
    }
    Ok(sha)
}

fn ensure_repo(dir: &Path) -> Result<()> {
    if !dir.is_dir() {
        bail!("git target is not a directory: {}", dir.display());
    }
    run_git(dir, &["rev-parse", "--is-inside-work-tree"])
        .with_context(|| format!("{} is not a git repository", dir.display()))?;
    Ok(())
}

// `-z` is required: without it git C-quotes an unusual filename, and the quoted
// name both dodges `is_sensitive_path` and breaks a later git call — there the
// non-zero exit reads as empty output, so the file's diff vanishes silently.
fn list_untracked(dir: &Path) -> Result<Vec<String>> {
    Ok(
        run_git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
    )
}

fn untracked_diff(dir: &Path, path: &str) -> Result<String> {
    run_git_status_ok(
        dir,
        &["diff", "--no-index", "--", "/dev/null", path],
        &[0, 1],
    )
}

fn run_git(dir: &Path, args: &[&str]) -> Result<String> {
    run_git_status_ok(dir, args, &[0])
}

fn run_git_status_ok(dir: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String> {
    let out = crate::spawn::command("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .with_context(|| format!("spawning git {args:?}"))?;
    let code = out.status.code();
    if !code.is_some_and(|c| ok_codes.contains(&c)) {
        bail!(
            "git {:?} in {} failed (exit {:?}): {}",
            args,
            dir.display(),
            code,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::fs;
    use std::process::Command;

    #[test]
    fn branch_cache_recomputes_only_when_head_bytes_change() {
        let dir = tempfile::tempdir().unwrap();
        let calls = std::cell::Cell::new(0);
        let compute = |name: &str| {
            calls.set(calls.get() + 1);
            Some(name.to_string())
        };

        let head_a = b"ref: refs/heads/main\n".to_vec();
        let first = branch_via_cache(dir.path(), head_a.clone(), || compute("main"));
        assert_eq!(first.as_deref(), Some("main"));
        assert_eq!(calls.get(), 1, "the first call must compute");

        let second = branch_via_cache(dir.path(), head_a.clone(), || {
            panic!("unchanged HEAD must not recompute")
        });
        assert_eq!(second.as_deref(), Some("main"));
        assert_eq!(calls.get(), 1, "an unchanged HEAD must not spawn git");

        let third = branch_via_cache(dir.path(), b"ref: refs/heads/other\n".to_vec(), || {
            compute("other")
        });
        assert_eq!(third.as_deref(), Some("other"));
        assert_eq!(calls.get(), 2, "a changed HEAD must recompute at once");
    }

    #[test]
    fn branch_cache_caches_a_none_answer_too() {
        let dir = tempfile::tempdir().unwrap();
        let head = b"9f3a1c2d4e5f60718293a4b5c6d7e8f901234567\n".to_vec();
        assert_eq!(branch_via_cache(dir.path(), head.clone(), || None), None);
        assert_eq!(
            branch_via_cache(dir.path(), head, || panic!("None must be cached too")),
            None
        );
    }

    #[test]
    fn branch_follows_a_real_checkout_immediately() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "one"]);

        assert_eq!(branch(dir.path()).as_deref(), Some("main"));
        assert_eq!(branch(dir.path()).as_deref(), Some("main"));
        git(dir.path(), &["checkout", "-b", "feature/x"]);
        assert_eq!(
            branch(dir.path()).as_deref(),
            Some("feature/x"),
            "a cached branch must never outlive the checkout that changed it"
        );
    }

    #[test]
    fn head_file_is_found_from_the_root_and_from_a_subdirectory() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let expected = dir.path().join(".git").join("HEAD");
        assert_eq!(head_file(dir.path()), Some(expected.clone()));

        let nested = dir.path().join("src").join("deep");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(head_file(&nested), Some(expected));
    }

    #[test]
    fn head_file_follows_a_linked_worktree_gitdir_file() {
        let repo = tempfile::tempdir().unwrap();
        init_repo(repo.path());
        fs::write(repo.path().join("a.txt"), "x").unwrap();
        git(repo.path(), &["add", "-A"]);
        git(repo.path(), &["commit", "-m", "one"]);

        let wt = repo.path().join("wt");
        git(
            repo.path(),
            &[
                "worktree",
                "add",
                &wt.display().to_string(),
                "-b",
                "wtbranch",
            ],
        );
        assert!(
            wt.join(".git").is_file(),
            "a linked worktree's .git is a file"
        );

        let head = head_file(&wt).expect("a linked worktree must resolve a HEAD");
        assert!(
            head.exists(),
            "the resolved HEAD must actually exist: {}",
            head.display()
        );
        assert_ne!(
            head,
            repo.path().join(".git").join("HEAD"),
            "it must NOT resolve to the parent repo's HEAD"
        );
        assert_eq!(branch(&wt).as_deref(), Some("wtbranch"));
    }

    #[test]
    fn head_file_is_none_outside_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(head_file(dir.path()), None);
        assert_eq!(branch(dir.path()), None);
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-b", "main"]);
        git(dir, &["config", "user.email", "t@t.local"]);
        git(dir, &["config", "user.name", "t"]);
        fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-m", "init"]);
    }

    #[test]
    fn status_reports_modified_and_untracked_with_counts() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README.md"), "hello\nworld\n").unwrap();
        fs::write(tmp.path().join("new.txt"), "brand new\n").unwrap();

        let files = status(tmp.path()).unwrap();
        let readme = files.iter().find(|f| f.path == "README.md").unwrap();
        assert_eq!(readme.status, proto::GitFileState::Modified);
        assert_eq!(readme.added, Some(1));
        assert_eq!(readme.deleted, Some(0));
        let new = files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(new.status, proto::GitFileState::Untracked);
        assert_eq!(new.added, None);
    }

    #[test]
    fn diff_covers_tracked_and_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README.md"), "hello\nmore\n").unwrap();
        fs::write(tmp.path().join("new.txt"), "brand new\n").unwrap();

        let d = diff(tmp.path(), None, None).unwrap();
        assert!(!d.truncated);
        assert!(d.patch.contains("+more"));
        assert!(d.patch.contains("+brand new"));

        let single = diff(tmp.path(), Some("new.txt"), None).unwrap();
        assert!(single.patch.contains("+brand new"));
        assert!(!single.patch.contains("+more"));
    }

    #[test]
    fn diff_truncates_on_char_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let big = "línea de relleno para inflar el diff\n".repeat(16_000);
        fs::write(tmp.path().join("big.txt"), big).unwrap();

        let d = diff(tmp.path(), None, None).unwrap();
        assert!(d.truncated);
        assert!(d.patch.len() <= PATCH_CAP_BYTES);
        assert!(d.patch.is_char_boundary(d.patch.len()));
    }

    #[test]
    fn non_git_dir_fails_loud() {
        let tmp = tempfile::tempdir().unwrap();
        let err = status(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("not a git repository"), "unexpected: {err}");
    }

    #[test]
    fn branch_reports_current_branch_name() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        assert_eq!(branch(tmp.path()), Some("main".to_string()));
    }

    #[test]
    fn branch_is_none_for_non_repo() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(branch(tmp.path()), None);
    }

    #[test]
    fn branch_is_none_for_detached_head() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let head = Command::new("git")
            .arg("-C")
            .arg(tmp.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        git(tmp.path(), &["checkout", &sha]);
        assert_eq!(branch(tmp.path()), None);
    }

    #[test]
    fn status_splits_staged_and_unstaged_sides() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README.md"), "hello\nstaged\n").unwrap();
        git(tmp.path(), &["add", "README.md"]);
        fs::write(tmp.path().join("README.md"), "hello\nstaged\nunstaged\n").unwrap();

        let files = status(tmp.path()).unwrap();
        let staged = files
            .iter()
            .find(|f| f.path == "README.md" && f.staged)
            .unwrap();
        assert_eq!(staged.status, proto::GitFileState::Modified);
        assert_eq!(staged.added, Some(1));
        let unstaged = files
            .iter()
            .find(|f| f.path == "README.md" && !f.staged)
            .unwrap();
        assert_eq!(unstaged.status, proto::GitFileState::Modified);
        assert_eq!(unstaged.added, Some(1));
    }

    #[test]
    fn stage_unstage_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("new.txt"), "brand new\n").unwrap();

        stage(tmp.path(), &["new.txt".to_string()]).unwrap();
        let staged = status(tmp.path()).unwrap();
        let f = staged.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(f.staged, "expected new.txt staged after stage()");
        assert_eq!(f.status, proto::GitFileState::Added);

        unstage(tmp.path(), &["new.txt".to_string()]).unwrap();
        let after = status(tmp.path()).unwrap();
        let f = after.iter().find(|f| f.path == "new.txt").unwrap();
        assert!(!f.staged, "expected new.txt unstaged after unstage()");
        assert_eq!(f.status, proto::GitFileState::Untracked);
    }

    #[test]
    fn commit_stages_and_records() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("feature.txt"), "work\n").unwrap();
        stage(tmp.path(), &[]).unwrap();

        let res = commit(tmp.path(), "  add feature  ").unwrap();
        assert!(res.sha.len() >= 7, "short sha: {}", res.sha);
        assert!(
            status(tmp.path()).unwrap().is_empty(),
            "tree should be clean"
        );

        let head = head_sha(tmp.path()).unwrap();
        assert!(head.starts_with(&res.sha), "{head} vs {}", res.sha);
        let subject = run_git(tmp.path(), &["log", "-1", "--format=%s"]).unwrap();
        assert_eq!(subject.trim(), "add feature");
    }

    #[test]
    fn commit_rejects_empty_message() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("x.txt"), "x\n").unwrap();
        stage(tmp.path(), &[]).unwrap();
        let err = commit(tmp.path(), "   ").unwrap_err().to_string();
        assert!(err.contains("empty message"), "unexpected: {err}");
    }

    #[test]
    fn sync_reports_branch_and_no_upstream() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let s = sync(tmp.path());
        assert_eq!(s.branch, Some("main".to_string()));
        assert_eq!(s.upstream, None);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
    }

    #[test]
    fn is_git_repo_true_for_repo_false_otherwise() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!is_git_repo(tmp.path()));
        init_repo(tmp.path());
        assert!(is_git_repo(tmp.path()));
    }

    const SENSITIVE_PATH_FIXTURE: &[(&str, bool)] = &[
        (".env", true),
        (".env.local", true),
        ("config/credentials.yml", true),
        ("app/secrets.json", true),
        ("keys/server.pem", true),
        ("certs/client.key", true),
        ("certs/bundle.p12", true),
        ("id_rsa", true),
        (".ssh/id_rsa_backup", true),
        ("docs/secretsanta.md", true),
        ("src/keyboard.ts", false),
        ("src/index.ts", false),
        ("README.md", false),
        ("package.json", false),
    ];

    #[test]
    fn is_sensitive_path_matches_review_ts_fixture() {
        for (path, expected) in SENSITIVE_PATH_FIXTURE {
            assert_eq!(
                is_sensitive_path(path),
                *expected,
                "is_sensitive_path({path:?}) expected {expected}"
            );
        }
    }

    #[test]
    fn diff_gates_single_sensitive_path_but_not_the_whole_tree() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join(".env"), "SECRET=abc123\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "add env"]);
        fs::write(tmp.path().join(".env"), "SECRET=changed\n").unwrap();
        fs::write(tmp.path().join("README.md"), "hello\nmore\n").unwrap();

        let single = diff(tmp.path(), Some(".env"), None).unwrap();
        assert!(
            single.patch.is_empty(),
            "sensitive single-path diff must be empty: {}",
            single.patch
        );
        assert!(!single.truncated);

        let whole = diff(tmp.path(), None, None).unwrap();
        assert!(
            whole.patch.contains("SECRET=changed"),
            "whole-tree diff must still contain the sensitive file's chunk: {}",
            whole.patch
        );
        assert!(whole.patch.contains("+more"));
    }

    #[test]
    fn status_flags_sensitive_files_on_both_staged_and_unstaged_sides() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join(".env"), "A=1\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "add env"]);
        fs::write(tmp.path().join(".env"), "A=2\n").unwrap();
        git(tmp.path(), &["add", ".env"]);
        fs::write(tmp.path().join(".env"), "A=3\n").unwrap();
        fs::write(tmp.path().join("plain.txt"), "hi\n").unwrap();

        let files = status(tmp.path()).unwrap();
        let env_entries: Vec<_> = files.iter().filter(|f| f.path == ".env").collect();
        assert_eq!(
            env_entries.len(),
            2,
            "expected staged + unstaged .env entries"
        );
        assert!(
            env_entries.iter().all(|f| f.is_sensitive),
            "both .env entries must be flagged sensitive: {env_entries:?}"
        );
        let plain = files.iter().find(|f| f.path == "plain.txt").unwrap();
        assert!(!plain.is_sensitive);
    }

    #[test]
    fn review_diffs_splits_staged_and_unstaged_into_separate_sections() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join("README.md"), "hello\nstaged\n").unwrap();
        git(tmp.path(), &["add", "README.md"]);
        fs::write(tmp.path().join("new.txt"), "brand new\n").unwrap();

        let bundle = review_diffs(tmp.path()).unwrap();
        assert_eq!(bundle.branch.as_deref(), Some("main"));
        assert_eq!(bundle.head.as_deref().map(|h| h.len()), Some(40));

        let staged = bundle
            .sections
            .iter()
            .find(|s| s.scope == proto::GitReviewScope::Staged)
            .expect("a staged section must be present");
        assert!(staged.patch.contains("+staged"), "{}", staged.patch);
        assert!(
            !staged.patch.contains("brand new"),
            "staged section must not leak the untracked file: {}",
            staged.patch
        );

        let untracked = bundle
            .sections
            .iter()
            .find(|s| s.scope == proto::GitReviewScope::Untracked)
            .expect("an untracked section must be present");
        assert!(untracked.patch.contains("brand new"), "{}", untracked.patch);

        assert!(
            !bundle
                .sections
                .iter()
                .any(|s| s.scope == proto::GitReviewScope::Unstaged),
            "an empty scope must be omitted, not sent empty: {:?}",
            bundle.sections
        );
    }

    #[test]
    fn review_diffs_drops_sensitive_file_content_but_lists_it_as_blocked() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(
            tmp.path().join(".env"),
            "just a plain sentence, no secret shape\n",
        )
        .unwrap();
        git(tmp.path(), &["add", "-A"]);

        let bundle = review_diffs(tmp.path()).unwrap();
        assert_eq!(bundle.blocked_paths, vec![".env".to_string()]);
        for s in &bundle.sections {
            assert!(
                !s.patch.contains("plain sentence"),
                "sensitive content leaked into a review section: {:?}",
                s.patch
            );
        }
    }

    #[test]
    fn review_diffs_dedups_blocked_paths_across_staged_and_unstaged() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(tmp.path().join(".env"), "A=1\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "add env"]);
        fs::write(tmp.path().join(".env"), "A=2\n").unwrap();
        git(tmp.path(), &["add", ".env"]);
        fs::write(tmp.path().join(".env"), "A=3\n").unwrap();

        let bundle = review_diffs(tmp.path()).unwrap();
        assert_eq!(bundle.blocked_paths, vec![".env".to_string()]);
    }

    #[test]
    fn review_diffs_redacts_secret_shaped_content_in_a_section() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(
            tmp.path().join("deploy.sh"),
            "curl -u AKIAIOSFODNN7EXAMPLE:secret https://example.com\n",
        )
        .unwrap();
        git(tmp.path(), &["add", "-A"]);

        let bundle = review_diffs(tmp.path()).unwrap();
        assert!(bundle.redacted, "redacted flag must be set");
        let staged = bundle
            .sections
            .iter()
            .find(|s| s.scope == proto::GitReviewScope::Staged)
            .unwrap();
        assert!(
            !staged.patch.contains("AKIAIOSFODNN7EXAMPLE"),
            "raw AWS key leaked into the review section: {}",
            staged.patch
        );
        assert!(
            staged.patch.contains("[redacted:aws_key]"),
            "{}",
            staged.patch
        );
    }

    #[test]
    fn review_diffs_warns_when_repo_has_no_commits_yet() {
        let tmp = tempfile::tempdir().unwrap();
        git(tmp.path(), &["init", "-b", "main"]);
        git(tmp.path(), &["config", "user.email", "t@t.local"]);
        git(tmp.path(), &["config", "user.name", "t"]);
        fs::write(tmp.path().join("a.txt"), "hi\n").unwrap();
        git(tmp.path(), &["add", "-A"]);

        let bundle = review_diffs(tmp.path()).unwrap();
        assert!(bundle.head.is_none());
        assert!(
            bundle.warnings.iter().any(|w| w.contains("no commits yet")),
            "expected a no-commits-yet warning: {:?}",
            bundle.warnings
        );
    }

    #[test]
    fn review_diffs_truncates_an_oversized_section_on_a_char_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let big = "línea de relleno para inflar el diff\n".repeat(16_000);
        fs::write(tmp.path().join("big.txt"), big).unwrap();

        let bundle = review_diffs(tmp.path()).unwrap();
        assert!(bundle.truncated);
        let untracked = bundle
            .sections
            .iter()
            .find(|s| s.scope == proto::GitReviewScope::Untracked)
            .unwrap();
        assert!(untracked.patch.len() <= PATCH_CAP_BYTES);
        assert!(untracked.patch.is_char_boundary(untracked.patch.len()));
    }

    #[test]
    fn review_diffs_redacts_colon_form_secret_via_generic_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        fs::write(
            tmp.path().join("docker-compose.yml"),
            "db_password: hunter2\n",
        )
        .unwrap();
        git(tmp.path(), &["add", "-A"]);

        let bundle = review_diffs(tmp.path()).unwrap();
        assert!(
            bundle.redacted,
            "redacted flag must be true for the colon-form secret"
        );
        let staged = bundle
            .sections
            .iter()
            .find(|s| s.scope == proto::GitReviewScope::Staged)
            .unwrap();
        assert!(!staged.patch.contains("hunter2"), "{}", staged.patch);
        assert!(
            staged.patch.contains("[redacted:env_secret]"),
            "{}",
            staged.patch
        );
    }

    #[test]
    fn exclude_sensitive_files_drops_a_chunk_renamed_out_of_a_sensitive_path() {
        let patch = "diff --git a/.env b/renamed_config.txt\n\
                      similarity index 90%\n\
                      rename from .env\n\
                      rename to renamed_config.txt\n\
                      --- a/.env\n\
                      +++ b/renamed_config.txt\n\
                      @@ -1,2 +1,2 @@\n\
                      \x20SECRET=abc\n\
                      -old line\n\
                      +new line\n";
        let out = exclude_sensitive_files(patch);
        assert!(
            !out.contains("SECRET=abc"),
            "a chunk renamed OUT of a sensitive path must still be excluded — it carries \
             the old file's content as unchanged context lines: {out}"
        );
    }

    #[test]
    fn exclude_sensitive_files_drops_a_chunk_renamed_into_a_sensitive_path() {
        let patch = "diff --git a/config.txt b/.env\n\
                      similarity index 90%\n\
                      rename from config.txt\n\
                      rename to .env\n\
                      --- a/config.txt\n\
                      +++ b/.env\n\
                      @@ -1,2 +1,2 @@\n\
                      \x20unchanged line\n\
                      -old line\n\
                      +new line\n";
        let out = exclude_sensitive_files(patch);
        assert!(
            !out.contains("unchanged line"),
            "a chunk renamed INTO a sensitive path must be excluded: {out}"
        );
    }

    #[test]
    fn exclude_sensitive_files_keeps_a_chunk_with_no_sensitive_side() {
        let patch = "diff --git a/foo.txt b/bar.txt\n\
                      --- a/foo.txt\n\
                      +++ b/bar.txt\n\
                      @@ -1 +1 @@\n\
                      -old\n\
                      +new\n";
        let out = exclude_sensitive_files(patch);
        assert!(out.contains("+new"), "{out}");
    }

    #[test]
    fn diff_includes_content_for_a_non_ascii_untracked_filename() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let name = "arquivo_não_ascii.txt";
        fs::write(tmp.path().join(name), "conteúdo novo\n").unwrap();

        let d = diff(tmp.path(), None, None).unwrap();
        assert!(d.patch.contains("conteúdo novo"), "{}", d.patch);
    }

    #[test]
    fn review_diffs_includes_diff_for_a_non_ascii_untracked_filename() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let name = "arquivo_não_ascii.txt";
        fs::write(tmp.path().join(name), "conteúdo novo\n").unwrap();

        let bundle = review_diffs(tmp.path()).unwrap();
        assert!(
            bundle.files.iter().any(|f| f.path == name),
            "expected the file to appear in files: {:?}",
            bundle.files
        );
        let untracked = bundle
            .sections
            .iter()
            .find(|s| s.scope == proto::GitReviewScope::Untracked)
            .expect("a non-ASCII untracked filename must still produce an untracked section");
        assert!(
            untracked.patch.contains("conteúdo novo"),
            "{}",
            untracked.patch
        );
    }

    #[test]
    fn list_untracked_returns_the_real_non_ascii_filename_not_a_quoted_literal() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let name = "arquivo_não_ascii.txt";
        fs::write(tmp.path().join(name), "x\n").unwrap();

        let files = list_untracked(tmp.path()).unwrap();
        assert_eq!(
            files,
            vec![name.to_string()],
            "expected the literal filename, not a quoted/escaped form: {files:?}"
        );
    }

    #[test]
    fn review_diffs_excludes_a_sensitive_non_ascii_untracked_filename() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let name = ".env_não_ascii";
        fs::write(tmp.path().join(name), "SECRET=abc\n").unwrap();

        let bundle = review_diffs(tmp.path()).unwrap();
        assert!(
            bundle.blocked_paths.contains(&name.to_string()),
            "expected the non-ASCII sensitive file to be recognized and blocked: {:?}",
            bundle.blocked_paths
        );
        for s in &bundle.sections {
            assert!(
                !s.patch.contains("SECRET=abc"),
                "a sensitive non-ASCII filename must never have its content shelled out for: {}",
                s.patch
            );
        }
    }

    #[test]
    fn list_branches_marks_current_default_upstream_and_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        git(tmp.path(), &["branch", "feature/x"]);
        let wt = tmp.path().join("wt");
        git(
            tmp.path(),
            &[
                "worktree",
                "add",
                &wt.display().to_string(),
                "-b",
                "task/wt",
            ],
        );

        let list = list_branches(tmp.path()).unwrap();
        assert_eq!(list.default_branch.as_deref(), Some("main"));
        let main = list
            .branches
            .iter()
            .find(|b| b.name == "main")
            .expect("main must be listed");
        assert!(main.current, "main is checked out");
        assert!(main.is_default, "main is the default branch");
        assert_eq!(main.worktree_path.as_deref(), tmp.path().to_str());

        let feature = list
            .branches
            .iter()
            .find(|b| b.name == "feature/x")
            .expect("a side branch must be listed");
        assert!(!feature.current);
        assert!(!feature.is_default);
        assert_eq!(feature.worktree_path, None);

        let task = list
            .branches
            .iter()
            .find(|b| b.name == "task/wt")
            .expect("the worktree branch must be listed");
        assert_eq!(task.worktree_path.as_deref(), wt.to_str());

        assert!(
            list.remotes.is_empty(),
            "a repo with no remote has no remote refs: {:?}",
            list.remotes
        );
        assert!(!list.truncated);
    }

    #[test]
    fn create_switch_rename_delete_branch_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());

        create_branch(tmp.path(), "feat/new", None, false).unwrap();
        assert_eq!(branch(tmp.path()).as_deref(), Some("main"));

        create_branch(tmp.path(), "feat/switched", Some("feat/new"), true).unwrap();
        assert_eq!(
            branch(tmp.path()).as_deref(),
            Some("feat/switched"),
            "switch:true must leave the repo on the new branch"
        );

        rename_branch(tmp.path(), "feat/new", "feat/renamed").unwrap();
        let list = list_branches(tmp.path()).unwrap();
        assert!(list.branches.iter().any(|b| b.name == "feat/renamed"));
        assert!(!list.branches.iter().any(|b| b.name == "feat/new"));

        switch_branch(tmp.path(), "main").unwrap();
        assert_eq!(branch(tmp.path()).as_deref(), Some("main"));

        delete_branch(tmp.path(), "feat/switched", false).unwrap();
        delete_branch(tmp.path(), "feat/renamed", false).unwrap();
        let list = list_branches(tmp.path()).unwrap();
        assert!(!list.branches.iter().any(|b| b.name.starts_with("feat/")));
    }

    #[test]
    fn create_branch_refuses_an_existing_or_invalid_name() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());

        let err = create_branch(tmp.path(), "main", None, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("already exists"), "unexpected: {err}");

        let err = create_branch(tmp.path(), "-evil", None, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("starts with '-'"), "unexpected: {err}");

        let err = create_branch(tmp.path(), "bad..name", None, false)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("not a valid git branch name"),
            "unexpected: {err}"
        );

        let err = create_branch(tmp.path(), "ok-name", Some("nope"), false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not resolve"), "unexpected: {err}");
    }

    #[test]
    fn delete_branch_refuses_current_and_unmerged_without_force() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());

        let err = delete_branch(tmp.path(), "main", false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("current branch"), "unexpected: {err}");

        create_branch(tmp.path(), "feat/work", None, true).unwrap();
        fs::write(tmp.path().join("work.txt"), "work\n").unwrap();
        git(tmp.path(), &["add", "-A"]);
        git(tmp.path(), &["commit", "-m", "work"]);
        switch_branch(tmp.path(), "main").unwrap();

        let err = delete_branch(tmp.path(), "feat/work", false)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("not fully merged"),
            "safe delete must refuse an unmerged branch and name the way out: {err}"
        );
        delete_branch(tmp.path(), "feat/work", true).unwrap();
        assert!(!branch_exists(tmp.path(), "feat/work"));
    }

    #[test]
    fn delete_branch_refuses_one_checked_out_in_a_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let wt = tmp.path().join("wt");
        git(
            tmp.path(),
            &[
                "worktree",
                "add",
                &wt.display().to_string(),
                "-b",
                "task/wt",
            ],
        );

        let err = delete_branch(tmp.path(), "task/wt", true)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("checked out in the worktree"),
            "unexpected: {err}"
        );
        assert!(
            err.contains("remove that worktree first"),
            "unexpected: {err}"
        );
    }

    fn init_bare(dir: &Path) {
        let out = Command::new("git")
            .args(["init", "--bare", "-b", "main"])
            .arg(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git init --bare: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn clone_of(root: &Path, origin: &Path, name: &str) -> PathBuf {
        let clone = root.join(name);
        let out = Command::new("git")
            .arg("clone")
            .arg(origin)
            .arg(&clone)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "clone {name}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        git(&clone, &["config", "user.email", "t@t.local"]);
        git(&clone, &["config", "user.name", "t"]);
        clone
    }

    // A bare origin seeded through a normal repo: pushing to a non-bare origin's
    // checked-out branch is refused by git, so the fixture must not use one.
    fn seeded_origin(root: &Path) -> PathBuf {
        let origin = root.join("origin.git");
        init_bare(&origin);
        let seed = root.join("seed");
        fs::create_dir_all(&seed).unwrap();
        init_repo(&seed);
        git(
            &seed,
            &["remote", "add", "origin", &origin.display().to_string()],
        );
        git(&seed, &["push", "-u", "origin", "main"]);
        origin
    }

    #[test]
    fn switch_to_a_remote_tracking_branch_sets_up_the_local_twin() {
        let root = tempfile::tempdir().unwrap();
        let origin = seeded_origin(root.path());
        let clone = clone_of(root.path(), &origin, "clone");
        git(&clone, &["checkout", "-b", "feature/remote"]);
        fs::write(clone.join("f.txt"), "remote work\n").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "-m", "remote work"]);
        git(&clone, &["push", "-u", "origin", "feature/remote"]);
        git(&clone, &["checkout", "main"]);
        git(&clone, &["branch", "-D", "feature/remote"]);
        git(&clone, &["fetch", "origin"]);

        switch_branch(&clone, "origin/feature/remote").unwrap();
        assert_eq!(
            branch(&clone).as_deref(),
            Some("feature/remote"),
            "checking out origin/x must land on local x with the upstream set"
        );
        let list = list_branches(&clone).unwrap();
        let local = list
            .branches
            .iter()
            .find(|b| b.name == "feature/remote")
            .unwrap();
        assert_eq!(
            local.upstream.as_deref(),
            Some("origin/feature/remote"),
            "the local twin must track the remote ref it came from"
        );
    }

    #[test]
    fn pull_refuses_detached_head_and_a_branch_without_upstream() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let err = pull(tmp.path()).unwrap_err().to_string();
        assert!(
            err.contains("no upstream"),
            "an upstream-less branch must be named as such: {err}"
        );

        let sha = head_sha(tmp.path()).unwrap();
        git(tmp.path(), &["checkout", &sha]);
        let err = pull(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("detached HEAD"), "unexpected: {err}");
    }

    #[test]
    fn pull_fast_forwards_from_a_local_remote_and_reports_up_to_date() {
        let root = tempfile::tempdir().unwrap();
        let origin = seeded_origin(root.path());
        let clone = clone_of(root.path(), &origin, "clone");
        let second = clone_of(root.path(), &origin, "second");

        fs::write(second.join("pushed.txt"), "from the other clone\n").unwrap();
        git(&second, &["add", "-A"]);
        git(&second, &["commit", "-m", "upstream moved"]);
        git(&second, &["push"]);

        let pulled = pull(&clone).unwrap();
        assert_eq!(pulled.status, PullStatus::Pulled);
        assert_eq!(pulled.branch, "main");
        assert_eq!(pulled.upstream.as_deref(), Some("origin/main"));
        assert!(clone.join("pushed.txt").exists());

        let again = pull(&clone).unwrap();
        assert_eq!(
            again.status,
            PullStatus::UpToDate,
            "a second pull with nothing to fetch must say so"
        );
    }

    #[test]
    fn push_publishes_a_branch_with_no_upstream_and_sets_it() {
        let root = tempfile::tempdir().unwrap();
        let origin = seeded_origin(root.path());
        let clone = clone_of(root.path(), &origin, "clone");

        git(&clone, &["branch", "--unset-upstream"]);
        assert_eq!(sync(&clone).upstream, None);
        push(&clone).unwrap();
        assert_eq!(
            sync(&clone).upstream.as_deref(),
            Some("origin/main"),
            "a first push must set the upstream instead of asking for a terminal"
        );

        git(&clone, &["checkout", "-b", "feat/panel"]);
        fs::write(clone.join("p.txt"), "work\n").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "-m", "panel work"]);
        push(&clone).unwrap();
        assert_eq!(
            sync(&clone).upstream.as_deref(),
            Some("origin/feat/panel"),
            "a new branch pushes to a remote branch of its own name"
        );
        let remote_refs = Command::new("git")
            .arg("-C")
            .arg(&origin)
            .args(["branch", "--list", "--format=%(refname:short)"])
            .output()
            .unwrap();
        let refs = String::from_utf8_lossy(&remote_refs.stdout);
        assert!(refs.contains("feat/panel"), "{refs}");
    }

    #[test]
    fn push_retargets_an_upstream_that_is_really_the_base() {
        let root = tempfile::tempdir().unwrap();
        let origin = seeded_origin(root.path());
        let clone = clone_of(root.path(), &origin, "clone");

        git(&clone, &["checkout", "-b", "fix/login"]);
        git(
            &clone,
            &["branch", "--set-upstream-to=origin/main", "fix/login"],
        );
        fs::write(clone.join("f.txt"), "fix\n").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "-m", "fix login"]);

        push(&clone).unwrap();
        assert_eq!(
            sync(&clone).upstream.as_deref(),
            Some("origin/fix/login"),
            "an upstream that is the base must be retargeted to a branch of the local name"
        );
        // main must not have received the feature commit.
        let main = Command::new("git")
            .arg("-C")
            .arg(&origin)
            .args(["log", "-1", "--format=%s", "main"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&main.stdout).trim(), "init");
    }

    #[test]
    fn push_refuses_detached_head_and_a_missing_remote() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let err = push(tmp.path()).unwrap_err().to_string();
        assert!(
            err.contains("no git remote"),
            "an upstream-less, remote-less repo must name the missing remote: {err}"
        );

        let sha = head_sha(tmp.path()).unwrap();
        git(tmp.path(), &["checkout", &sha]);
        let err = push(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("detached HEAD"), "unexpected: {err}");
    }

    #[test]
    fn fetch_reports_an_absent_remote_and_summarizes_a_real_one() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let err = fetch(tmp.path()).unwrap_err().to_string();
        assert!(err.contains("no git remote"), "unexpected: {err}");

        let origin = tempfile::tempdir().unwrap();
        init_repo(origin.path());
        git(
            tmp.path(),
            &[
                "remote",
                "add",
                "origin",
                &origin.path().display().to_string(),
            ],
        );
        let summary = fetch(tmp.path()).unwrap();
        assert!(!summary.is_empty());
    }

    #[test]
    fn sanitized_patch_caps_excludes_and_redacts() {
        let (patch, truncated, redacted) = sanitized_patch(
            "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-SECRET=old\n+SECRET=new\n".into(),
        );
        assert!(
            patch.is_empty(),
            "a sensitive chunk must be dropped: {patch}"
        );
        assert!(!truncated);
        assert!(!redacted);

        let (patch, _, redacted) = sanitized_patch(
            "diff --git a/x.yml b/x.yml\n--- a/x.yml\n+++ b/x.yml\n@@ -1 +1 @@\n-old: 1\n+db_password: hunter2\n".into(),
        );
        assert!(!patch.contains("hunter2"), "{patch}");
        assert!(redacted);
    }
}
