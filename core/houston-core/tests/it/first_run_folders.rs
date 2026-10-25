#![allow(clippy::disallowed_methods)]

//! First-run workspace discovery over a seeded home: the daemon env resolves the
//! roots, and the scan offers exactly the existing git repositories the agent
//! CLIs have transcripts for.

use crate::common;
use houston_core::first_run_scan::{resolve_roots, scan, ScanOutcome};
use houston_core::host_env::HostEnv;
use std::path::{Path, PathBuf};

const NOW_MS: i64 = 1_800_000_000_000;

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

/// A path embedded as a JSON string value: backslashes are escapes there.
fn json_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\")
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

struct Seeded {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    /// The qualifying repos, newest activity first.
    repos: Vec<PathBuf>,
    scratch: PathBuf,
    claude_alt: PathBuf,
    codex_alt: PathBuf,
}

/// A home with Claude and Codex histories over two repos, one scratch folder,
/// a cwd-less transcript and one transcript outside the scan window. `seed_alt`
/// additionally seeds the same history under the CLIs' config-dir overrides.
fn seed(seed_alt: bool) -> Seeded {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let repo_a = tmp.path().join("code/app");
    let repo_b = tmp.path().join("code/lib");
    let scratch = tmp.path().join("scratch");
    git_init(&repo_a);
    git_init(&repo_b);
    std::fs::create_dir_all(&scratch).unwrap();

    let claude_alt = home.join("claude-alt");
    let codex_alt = home.join("codex-alt");
    let layouts: Vec<(PathBuf, PathBuf)> = if seed_alt {
        vec![
            (home.join(".claude/projects"), home.join(".codex/sessions")),
            (claude_alt.join("projects"), codex_alt.join("sessions")),
        ]
    } else {
        vec![(home.join(".claude/projects"), home.join(".codex/sessions"))]
    };
    for (claude_root, codex_root) in layouts {
        let a = json_path(&repo_a);
        let b = json_path(&repo_b);
        write(
            &claude_root.join("bucket-a/s1.jsonl"),
            &format!("{{\"type\":\"user\",\"cwd\":\"{a}\"}}\n"),
        );
        write(
            &claude_root.join("bucket-a/s2.jsonl"),
            &format!("{{\"type\":\"user\",\"cwd\":\"{a}\"}}\n"),
        );
        write(
            &claude_root.join("bucket-b/s3.jsonl"),
            &format!("{{\"type\":\"user\",\"cwd\":\"{b}\"}}\n"),
        );
        write(
            &claude_root.join("bucket-scratch/s4.jsonl"),
            &format!(
                "{{\"type\":\"user\",\"cwd\":\"{}\"}}\n",
                json_path(&scratch)
            ),
        );
        write(&claude_root.join("bucket-cwdless/s5.jsonl"), "{\"x\":1}\n");
        write(
            &claude_root.join("bucket-notes/s6.md"),
            &format!("{{\"cwd\":\"{a}\"}}\n"),
        );
        let old = claude_root.join("bucket-a/s7.jsonl");
        write(&old, &format!("{{\"type\":\"user\",\"cwd\":\"{b}\"}}\n"));
        set_mtime(
            &old,
            NOW_MS - (houston_core::first_run_scan::SCAN_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1_000,
        );

        write(
            &codex_root.join("2026/10/24/rollout-1.jsonl"),
            &format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"s\",\"cwd\":\"{a}\"}}}}\n"
            ),
        );

        set_mtime(&claude_root.join("bucket-a/s1.jsonl"), NOW_MS - 1_000);
        set_mtime(&claude_root.join("bucket-a/s2.jsonl"), NOW_MS - 2_000);
        set_mtime(&claude_root.join("bucket-b/s3.jsonl"), NOW_MS - 3_000);
        set_mtime(
            &codex_root.join("2026/10/24/rollout-1.jsonl"),
            NOW_MS - 4_000,
        );
    }

    Seeded {
        _tmp: tmp,
        home,
        repos: vec![repo_a, repo_b],
        scratch,
        claude_alt,
        codex_alt,
    }
}

fn scanned(env: &HostEnv) -> ScanOutcome {
    let roots = resolve_roots(env).expect("the seeded env has a home");
    scan(&roots, NOW_MS)
}

fn offered_paths(outcome: &ScanOutcome) -> Vec<String> {
    outcome.folders.iter().map(|f| f.path.clone()).collect()
}

#[test]
fn discovery_offers_exactly_the_git_repos_the_clis_transcribed() {
    let s = seed(false);
    let env = common::base_env()
        .with("HOME", Some(s.home.clone()))
        .with("USERPROFILE", Some(s.home.clone()))
        .without("CLAUDE_CONFIG_DIR")
        .without("CODEX_HOME");

    let outcome = scanned(&env);
    assert_eq!(outcome.capped, None);
    assert_eq!(
        offered_paths(&outcome),
        s.repos
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        "newest activity first; scratch folders and non-repositories are not offered"
    );
    let app = &outcome.folders[0];
    assert_eq!(
        app.sessions, 3,
        "two Claude sessions plus one Codex rollout"
    );
    assert_eq!(app.last_active_ms, NOW_MS - 1_000);
    // In-window .jsonl transcripts read: s1, s2, s3, s4, s5 and the rollout. The
    // old s7 and the .md are never opened.
    assert_eq!(outcome.transcripts_read, 6);
}

#[test]
fn discovery_honours_the_cli_config_dir_overrides() {
    let s = seed(true);
    let env = common::base_env()
        .with("HOME", Some(s.home.clone()))
        .with("USERPROFILE", Some(s.home.clone()))
        .with("CLAUDE_CONFIG_DIR", Some(s.claude_alt.clone()))
        .with("CODEX_HOME", Some(s.codex_alt.clone()));

    let outcome = scanned(&env);
    assert_eq!(
        offered_paths(&outcome),
        s.repos
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        "the overridden roots are scanned, not the home defaults"
    );
    assert_eq!(outcome.folders[0].sessions, 3);
    let _ = s.scratch;
}
