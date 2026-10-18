//! Hermetic `gh` fixture. Only integration tests run it, after copying it to
//! `<dir>/gh` (`gh.exe` on Windows) at the front of their own `PATH`; nothing
//! in Houston names this binary. It answers from files in its own directory:
//!
//! - `pr-N.json`: the `gh pr view N` payload. With an `origin` file naming a
//!   bare repository, `headRefOid` is that repository's tip of `headRefName`,
//!   as GitHub would report after a push.
//! - `threads-N.json`: the review-threads GraphQL answer (else no threads).
//! - `methods`: the allowed merge methods, comma-separated (else all three).
//! - `merge-refused`: `gh pr merge` fails with this text. Otherwise the merge
//!   succeeds and, with `origin`, moves the base branch there to the merged commit.
//!
//! Every call is appended to `gh.log`, one line of arguments each.
#![allow(clippy::disallowed_methods)] // a fixture runs git directly and reads its own environment
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

fn dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

fn read(name: &str) -> Option<String> {
    std::fs::read_to_string(dir().join(name)).ok()
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    exit(1)
}

fn origin_tip(branch: &str) -> Option<String> {
    let origin = read("origin")?;
    let out = Command::new("git")
        .args([
            "--git-dir",
            origin.trim(),
            "rev-parse",
            "--verify",
            "--quiet",
        ])
        .arg(format!("refs/heads/{branch}"))
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn pr(number: &str) -> Option<serde_json::Value> {
    let mut value: serde_json::Value =
        serde_json::from_str(&read(&format!("pr-{number}.json"))?).ok()?;
    let branch = value.get("headRefName")?.as_str()?.to_string();
    if let Some(tip) = origin_tip(&branch) {
        value["headRefOid"] = tip.into();
    }
    Some(value)
}

fn graphql() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let number = input
        .split("\"number\":")
        .nth(1)
        .map(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .unwrap_or_default();
    if input.contains("reviewThreads") {
        let threads = read(&format!("threads-{number}.json")).unwrap_or_else(|| {
            r#"{"data":{"repository":{"pullRequest":{"id":"x","reviewThreads":{"totalCount":0,"pageInfo":{"hasNextPage":false},"nodes":[]}}}}}"#.to_string()
        });
        print!("{threads}");
        return;
    }
    if input.contains("revertPullRequest") {
        print!(
            r#"{{"data":{{"revertPullRequest":{{"revertPullRequest":{{"number":900,"url":"https://github.com/owner/repo/pull/900"}}}}}}}}"#
        );
        return;
    }
    let methods = read("methods").unwrap_or_else(|| "squash,merge,rebase".into());
    let allowed = |m: &str| methods.split(',').any(|x| x.trim() == m);
    print!(
        r#"{{"data":{{"repository":{{"viewerPermission":"WRITE","squashMergeAllowed":{},"mergeCommitAllowed":{},"rebaseMergeAllowed":{},"pullRequest":{{"id":"PR_{number}","viewerCanUpdate":true,"viewerDidAuthor":true,"viewerCanUpdateBranch":false}}}}}}}}"#,
        allowed("squash"),
        allowed("merge"),
        allowed("rebase")
    );
}

fn merge(args: &[String]) {
    if let Some(refused) = read("merge-refused") {
        fail(refused.trim());
    }
    let number = &args[2];
    let sha = args
        .iter()
        .position(|a| a == "--match-head-commit")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default();
    let Some(mut value) = pr(number) else {
        fail(&format!(
            "GraphQL: Could not resolve to a PullRequest with the number of {number}."
        ));
    };
    if value["headRefOid"].as_str() != Some(sha.as_str()) {
        fail("Head branch was modified. Review and try the merge again.");
    }
    if let (Some(origin), Some(base)) = (read("origin"), value["baseRefName"].as_str()) {
        let ok = Command::new("git")
            .args(["--git-dir", origin.trim(), "update-ref"])
            .arg(format!("refs/heads/{base}"))
            .arg(&sha)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            fail("fake gh: moving the base in origin failed");
        }
    }
    value["state"] = "MERGED".into();
    value["mergedAt"] = "2026-10-18T06:40:00Z".into();
    let _ = std::fs::write(dir().join(format!("pr-{number}.json")), value.to_string());
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir().join("gh.log"))
    {
        let _ = writeln!(log, "{}", args.join(" "));
    }
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
    match (arg(0), arg(1)) {
        ("--version", _) => println!("gh version 2.0.0"),
        ("auth", _) => {}
        ("pr", "view") => match pr(arg(2)) {
            Some(value) => print!("{value}"),
            None => fail(&format!(
                "GraphQL: Could not resolve to a PullRequest with the number of {}.",
                arg(2)
            )),
        },
        ("pr", "merge") => merge(&args),
        ("api", "graphql") => graphql(),
        ("api", _) => fail("gh: Not Found (HTTP 404)"),
        _ => fail(&format!("fake gh: unsupported call {args:?}")),
    }
}
