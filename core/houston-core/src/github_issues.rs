//! GitHub Issues through the user's own `gh` login: the repository a
//! workspace's remote names, its open issues, and the two writes Houston makes
//! (open an issue, comment on one). Houston stores no GitHub token.
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// The `backlog_task_links.provider` of a GitHub issue.
pub const PROVIDER: &str = "github";

/// An unattended poll must not hold the loop on a `gh` that hangs on the network.
const GH_TIMEOUT: Duration = Duration::from_secs(60);

/// One list page; a workspace with more open issues than this imports the
/// newest first and the rest on later polls as they change.
const ISSUES_PER_PAGE: &str = "100";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    pub owner: String,
    pub name: String,
}

impl Repo {
    /// `owner/name`, as `gh --repo` takes it.
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }

    /// A link's external id: `owner/name#<number>`.
    pub fn issue_id(&self, number: u32) -> String {
        format!("{}#{number}", self.slug())
    }
}

/// The repository a remote URL names, when it is on github.com.
pub fn repo_of_remote(url: &str) -> Option<Repo> {
    if !url.contains("github.com") {
        return None;
    }
    let (owner, name) = crate::gh::split_repository(url)?;
    Some(Repo { owner, name })
}

/// The issue number of a link's external id in `repo`.
pub fn issue_number(repo: &Repo, external_id: &str) -> Option<u32> {
    external_id
        .strip_prefix(&format!("{}#", repo.slug()))
        .and_then(|n| n.parse().ok())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub url: String,
    pub author: String,
    pub updated_at: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Page {
    /// The ETag still matches: nothing changed since the last poll.
    NotModified,
    Fetched {
        etag: Option<String>,
        issues: Vec<Issue>,
    },
}

/// Parses `gh api -i`: a status line, headers, a blank line and the JSON
/// body. Pull requests (which the issues endpoint also lists) are skipped.
pub fn parse_issue_page(output: &str) -> Result<Page> {
    let output = output.replace("\r\n", "\n");
    let (head, body) = output.split_once("\n\n").unwrap_or((output.as_str(), ""));
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or_default();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .with_context(|| {
            format!("gh api printed no HTTP status line (expected `HTTP/2.0 200 OK`, got {status_line:?})")
        })?;
    if status == 304 {
        return Ok(Page::NotModified);
    }
    if status != 200 {
        let message = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| body.trim().chars().take(200).collect());
        bail!("GitHub answered HTTP {status}: {message}");
    }
    let etag = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("etag")
            .then(|| value.trim().to_string())
    });
    let items: Vec<serde_json::Value> =
        serde_json::from_str(body).context("the issue list is not a JSON array")?;
    let issues = items
        .into_iter()
        .filter(|item| item.get("pull_request").is_none())
        .filter_map(|item| {
            Some(Issue {
                number: u32::try_from(item["number"].as_u64()?).ok()?,
                title: item["title"].as_str()?.to_string(),
                body: item["body"].as_str().unwrap_or_default().to_string(),
                url: item["html_url"].as_str()?.to_string(),
                author: item["user"]["login"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                updated_at: item["updated_at"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect();
    Ok(Page::Fetched { etag, issues })
}

/// The unchecked `- [ ]` items of an issue body, in order: GitHub's task list
/// is the closest thing an issue has to acceptance criteria.
pub fn acceptance_from_body(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let rest = line
                .strip_prefix("- [ ]")
                .or_else(|| line.strip_prefix("* [ ]"))?;
            let text = rest.trim();
            (!text.is_empty()).then(|| text.to_string())
        })
        .collect()
}

/// What changed means "title or body changed": the hash of both.
pub fn body_hash(title: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.as_bytes());
    hasher.update([0]);
    hasher.update(body.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn gh(dir: &Path, args: &[&str]) -> Result<Output> {
    let mut cmd = crate::spawn::command("gh");
    cmd.current_dir(dir)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1");
    match crate::spawn::output_within(cmd, GH_TIMEOUT) {
        Ok(Some(out)) => Ok(Output {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Ok(None) => bail!(
            "gh {} gave no answer within {} s",
            args.first().copied().unwrap_or_default(),
            GH_TIMEOUT.as_secs()
        ),
        Err(e) => bail!("{} ({e})", crate::gh::MISSING_HINT),
    }
}

fn failed(what: &str, out: &Output) -> anyhow::Error {
    let line = out
        .stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("no error text")
        .trim()
        .to_string();
    anyhow::anyhow!("{what} failed: {line}")
}

/// The login of the `gh` user, whose assigned issues are imported.
pub fn viewer(dir: &Path) -> Result<String> {
    let out = gh(dir, &["api", "user", "--jq", ".login"])?;
    if !out.ok {
        return Err(failed("gh api user", &out));
    }
    let login = out.stdout.trim().to_string();
    if login.is_empty() {
        bail!("gh api user printed no login ({})", crate::gh::AUTH_HINT);
    }
    Ok(login)
}

/// One open-issue list, `filter` being `labels=<label>` or `assignee=<login>`.
/// `etag` makes an unchanged list a 304, which GitHub does not count.
pub fn list_open(dir: &Path, repo: &Repo, filter: &str, etag: Option<&str>) -> Result<Page> {
    let path = format!("repos/{}/issues", repo.slug());
    let state = "state=open".to_string();
    let per_page = format!("per_page={ISSUES_PER_PAGE}");
    let header = etag.map(|tag| format!("If-None-Match: {tag}"));
    let mut args = vec!["api", "-i", "-X", "GET", path.as_str()];
    for field in [&state, &per_page] {
        args.extend(["-f", field.as_str()]);
    }
    args.extend(["-f", filter]);
    if let Some(header) = &header {
        args.extend(["-H", header.as_str()]);
    }
    let out = gh(dir, &args)?;
    // `gh api` exits non-zero on a 304 too; the status line decides.
    match parse_issue_page(&out.stdout) {
        Ok(page) => Ok(page),
        Err(_) if !out.ok => Err(failed(&format!("gh api {path}"), &out)),
        Err(e) => Err(e),
    }
}

fn with_body_file<T>(body: &str, call: impl FnOnce(&str) -> Result<T>) -> Result<T> {
    let mut file = tempfile::Builder::new()
        .prefix("houston-issue-")
        .suffix(".md")
        .tempfile()
        .context("creating the issue body file")?;
    std::io::Write::write_all(&mut file, body.as_bytes()).context("writing the issue body")?;
    let path = file.path().display().to_string();
    call(&path)
}

/// `gh issue create`; answers the new issue's number and page.
pub fn create_issue(
    dir: &Path,
    repo: &Repo,
    title: &str,
    body: &str,
    label: Option<&str>,
) -> Result<(u32, String)> {
    let slug = repo.slug();
    with_body_file(body, |path| {
        let mut args = vec![
            "issue",
            "create",
            "--repo",
            slug.as_str(),
            "--title",
            title,
            "--body-file",
            path,
        ];
        if let Some(label) = label {
            args.extend(["--label", label]);
        }
        let out = gh(dir, &args)?;
        if !out.ok {
            return Err(failed(&format!("gh issue create in {slug}"), &out));
        }
        let url = out
            .stdout
            .lines()
            .rev()
            .find(|l| l.contains("/issues/"))
            .map(str::trim)
            .with_context(|| {
                format!(
                    "gh issue create printed no issue URL: {:?}",
                    out.stdout.trim()
                )
            })?
            .to_string();
        let number = url
            .rsplit('/')
            .next()
            .and_then(|n| n.parse().ok())
            .with_context(|| format!("issue URL {url:?} does not end in a number"))?;
        Ok((number, url))
    })
}

/// `gh issue comment`.
pub fn comment(dir: &Path, repo: &Repo, number: u32, body: &str) -> Result<()> {
    let slug = repo.slug();
    let n = number.to_string();
    with_body_file(body, |path| {
        let out = gh(
            dir,
            &[
                "issue",
                "comment",
                n.as_str(),
                "--repo",
                slug.as_str(),
                "--body-file",
                path,
            ],
        )?;
        if !out.ok {
            return Err(failed(&format!("gh issue comment {slug}#{number}"), &out));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_skips_pull_requests_and_keeps_the_etag() {
        let output = "HTTP/2.0 200 OK\r\nEtag: W/\"abc\"\r\nX-Other: 1\r\n\r\n[\
            {\"number\":12,\"title\":\"Fix it\",\"body\":\"- [ ] Works\",\"html_url\":\"https://github.com/o/r/issues/12\",\"user\":{\"login\":\"ana\"},\"updated_at\":\"2026-10-05T00:00:00Z\"},\
            {\"number\":14,\"title\":\"A PR\",\"body\":null,\"html_url\":\"https://github.com/o/r/pull/14\",\"user\":{\"login\":\"ana\"},\"pull_request\":{}}]";
        let Page::Fetched { etag, issues } = parse_issue_page(output).unwrap() else {
            panic!("expected a page");
        };
        assert_eq!(etag.as_deref(), Some("W/\"abc\""));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, 12);
        assert_eq!(issues[0].author, "ana");
    }

    #[test]
    fn a_304_is_not_modified_and_an_error_names_the_status() {
        assert_eq!(
            parse_issue_page("HTTP/2.0 304 Not Modified\nEtag: \"x\"\n\n").unwrap(),
            Page::NotModified
        );
        let e = parse_issue_page("HTTP/2.0 404 Not Found\n\n{\"message\":\"Not Found\"}")
            .unwrap_err()
            .to_string();
        assert!(e.contains("404") && e.contains("Not Found"), "{e}");
    }

    #[test]
    fn unchecked_task_list_items_become_acceptance() {
        let body = "Intro\n- [ ] First\n- [x] Done already\n  * [ ] Nested\n- [ ]   \n- plain";
        assert_eq!(acceptance_from_body(body), vec!["First", "Nested"]);
    }

    #[test]
    fn only_github_remotes_name_a_repository() {
        assert_eq!(
            repo_of_remote("git@github.com:o/r.git").map(|r| r.slug()),
            Some("o/r".to_string())
        );
        assert_eq!(repo_of_remote("https://bitbucket.org/o/r.git"), None);
        let repo = repo_of_remote("https://github.com/o/r").unwrap();
        assert_eq!(issue_number(&repo, "o/r#12"), Some(12));
        assert_eq!(issue_number(&repo, "x/y#12"), None);
    }
}
