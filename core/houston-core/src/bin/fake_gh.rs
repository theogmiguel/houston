//! Hermetic `gh` fixture: integration tests copy it to `<dir>/gh` (`gh.exe` on Windows)
//! at the front of their own `PATH`. It answers from files in its own directory, which
//! `graphql`, `merge` and `auto_merge` name, and appends every call to `gh.log`.
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

fn write(name: &str, content: &str) {
    let _ = std::fs::write(dir().join(name), content);
}

fn remove(name: &str) {
    let _ = std::fs::remove_file(dir().join(name));
}

/// Now as GitHub writes a timestamp, `YYYY-MM-DDTHH:MM:SSZ`.
fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem / 60 % 60,
        rem % 60
    )
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

/// `pr-N.json`, with `headRefOid` read from the bare repository the `origin` file
/// names, as GitHub reports a branch after a push.
fn pr(number: &str) -> Option<serde_json::Value> {
    let mut value: serde_json::Value =
        serde_json::from_str(&read(&format!("pr-{number}.json"))?).ok()?;
    let branch = value.get("headRefName")?.as_str()?.to_string();
    if let Some(tip) = origin_tip(&branch) {
        value["headRefOid"] = tip.into();
    }
    Some(value)
}

/// `threads-N.json` answers the review-threads read; `methods` lists the allowed merge
/// methods (all three by default). `merge-queue`, `merge-queue-hidden`, `auto-merge-allowed`
/// and `required-checks` set GitHub's merge tools; `queued-N`, `auto-N` and `removed-N` hold one PR's.
fn graphql() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let request: serde_json::Value = serde_json::from_str(&input).unwrap_or_default();
    let variables = &request["variables"];
    // A mutation names the pull request by the node id the access read answers, `PR_N`.
    let number = variables["number"]
        .as_u64()
        .map(|n| n.to_string())
        .or_else(|| {
            [&variables["pullRequestId"], &variables["id"]]
                .iter()
                .find_map(|v| v.as_str()?.strip_prefix("PR_").map(str::to_string))
        })
        .unwrap_or_default();
    if input.contains("enqueuePullRequest") {
        let expected = variables["expectedHeadOid"].as_str().unwrap_or_default();
        let head = pr(&number).and_then(|v| v["headRefOid"].as_str().map(str::to_string));
        if head.as_deref() != Some(expected) {
            fail("GraphQL: Head ref has been modified since the expected head oid was provided");
        }
        write(&format!("queued-{number}"), expected);
        print!(r#"{{"data":{{"enqueuePullRequest":{{"mergeQueueEntry":{{"position":1}}}}}}}}"#);
        return;
    }
    if input.contains("dequeuePullRequest") {
        if read(&format!("queued-{number}")).is_none() {
            fail("GraphQL: Pull request is not in the merge queue");
        }
        remove(&format!("queued-{number}"));
        print!(
            r#"{{"data":{{"dequeuePullRequest":{{"mergeQueueEntry":{{"id":"MQE_{number}"}}}}}}}}"#
        );
        return;
    }
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
    let queue_entry = match read(&format!("queued-{number}")) {
        Some(sha) => serde_json::json!({
            "state": "QUEUED", "position": 1, "headCommit": { "oid": sha.trim() }
        }),
        None => serde_json::Value::Null,
    };
    let auto_merge = match read(&format!("auto-{number}")) {
        Some(method) => serde_json::json!({ "mergeMethod": method.trim().to_ascii_uppercase() }),
        None => serde_json::Value::Null,
    };
    let rule = match read("required-checks") {
        Some(checks) => serde_json::json!({
            "requiredStatusCheckContexts":
                checks.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect::<Vec<_>>()
        }),
        None => serde_json::Value::Null,
    };
    let timeline: Vec<serde_json::Value> = read(&format!("removed-{number}"))
        .map(|reason| serde_json::json!({ "createdAt": now_rfc3339(), "reason": reason.trim() }))
        .into_iter()
        .collect();
    let answer = serde_json::json!({ "data": { "repository": {
        "viewerPermission": "WRITE",
        "squashMergeAllowed": allowed("squash"),
        "mergeCommitAllowed": allowed("merge"),
        "rebaseMergeAllowed": allowed("rebase"),
        "autoMergeAllowed": read("auto-merge-allowed").is_some(),
        "pullRequest": {
            "id": format!("PR_{number}"),
            "viewerCanUpdate": true,
            "viewerDidAuthor": true,
            "viewerCanUpdateBranch": false,
            "isMergeQueueEnabled": match read("merge-queue-hidden") {
                Some(_) => serde_json::Value::Null,
                None => read("merge-queue").is_some().into(),
            },
            "mergeQueueEntry": queue_entry,
            "autoMergeRequest": auto_merge,
            "timelineItems": { "nodes": timeline },
            "baseRef": { "refUpdateRule": rule }
        }
    } } });
    print!("{answer}");
}

/// `pr edit N --base B` moves the pull request's base.
fn edit(args: &[String]) {
    let number = &args[2];
    let Some(base) = args
        .iter()
        .position(|a| a == "--base")
        .and_then(|i| args.get(i + 1))
    else {
        fail("fake gh: pr edit needs --base");
    };
    let Some(mut value) = read(&format!("pr-{number}.json"))
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    else {
        fail(&format!(
            "GraphQL: Could not resolve to a PullRequest with the number of {number}."
        ));
    };
    value["baseRefName"] = base.as_str().into();
    write(&format!("pr-{number}.json"), &value.to_string());
}

/// `pr merge N --auto` arms auto-merge pinned to the head (`auto-refused` refuses
/// it with its text); `--disable-auto` turns it off.
fn auto_merge(args: &[String]) {
    let number = &args[2];
    if args.iter().any(|a| a == "--disable-auto") {
        remove(&format!("auto-{number}"));
        return;
    }
    if let Some(refused) = read("auto-refused") {
        fail(refused.trim());
    }
    let sha = args
        .iter()
        .position(|a| a == "--match-head-commit")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default();
    if pr(number).and_then(|v| v["headRefOid"].as_str().map(str::to_string)) != Some(sha) {
        fail("Head branch was modified. Review and try the merge again.");
    }
    let method = ["--squash", "--merge", "--rebase"]
        .into_iter()
        .find(|m| args.iter().any(|a| a == m))
        .map_or("squash", |m| m.trim_start_matches("--"));
    write(&format!("auto-{number}"), method);
}

/// `merge-refused` makes the merge fail with its text; otherwise the base in `origin`
/// moves to the merged commit (with `squash`, to a new commit of the head's tree) and
/// the pull request reads as merged.
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
        let merged = if read("squash").is_some() {
            squash(origin.trim(), base, &sha)
        } else {
            Some(sha.clone())
        };
        let ok = merged.is_some_and(|merged| {
            Command::new("git")
                .args(["--git-dir", origin.trim(), "update-ref"])
                .arg(format!("refs/heads/{base}"))
                .arg(&merged)
                .status()
                .is_ok_and(|s| s.success())
        });
        if !ok {
            fail("fake gh: moving the base in origin failed");
        }
    }
    value["state"] = "MERGED".into();
    value["mergedAt"] = "2026-10-18T06:40:00Z".into();
    let _ = std::fs::write(dir().join(format!("pr-{number}.json")), value.to_string());
}

/// One commit on `base` with `head`'s tree: the base after a squash merge.
fn squash(origin: &str, base: &str, head: &str) -> Option<String> {
    let parent = Command::new("git")
        .args([
            "--git-dir",
            origin,
            "rev-parse",
            &format!("refs/heads/{base}"),
        ])
        .output()
        .ok()?;
    let parent = String::from_utf8_lossy(&parent.stdout).trim().to_string();
    let out = Command::new("git")
        .args([
            "--git-dir",
            origin,
            "commit-tree",
            &format!("{head}^{{tree}}"),
        ])
        .args(["-p", &parent, "-m", "squash merge"])
        .env("GIT_AUTHOR_NAME", "github")
        .env("GIT_AUTHOR_EMAIL", "github@example.invalid")
        .env("GIT_COMMITTER_NAME", "github")
        .env("GIT_COMMITTER_EMAIL", "github@example.invalid")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Concurrent calls (a read's access and thread queries) each append whole lines.
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir().join("gh.log"))
    {
        let _ = log.lock();
        let _ = log.write_all(format!("{}\n", args.join(" ")).as_bytes());
        let _ = log.unlock();
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
        ("pr", "merge") if args.iter().any(|a| a == "--auto" || a == "--disable-auto") => {
            auto_merge(&args)
        }
        ("pr", "merge") => merge(&args),
        ("pr", "edit") => edit(&args),
        ("api", "graphql") => graphql(),
        ("api", _) => fail("gh: Not Found (HTTP 404)"),
        _ => fail(&format!("fake gh: unsupported call {args:?}")),
    }
}
