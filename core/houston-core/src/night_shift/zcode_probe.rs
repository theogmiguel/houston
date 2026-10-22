//! ZCode reports no usage limit: a pane at its quota keeps showing Working.
//! One short headless request (`zcode -p`) tells a slow turn from a spent
//! quota or a signed-out CLI. It sends `PROMPT` to the user's ZCode provider.
use std::path::Path;
use std::time::Duration;

pub const PROMPT: &str = "Reply with the single word OK.";

/// A refused request returns in about 20 s, after ZCode's own retries; an
/// answer takes a few seconds. Past this the probe counts as failed.
pub const TIMEOUT: Duration = Duration::from_secs(90);

/// Longest reason kept from ZCode's output.
const REASON_MAX: usize = 200;

/// No tools, so the probe cannot touch the directory it runs in.
pub fn argv() -> Vec<&'static str> {
    vec![
        "-p",
        PROMPT,
        "--mode",
        "build",
        "--disallowed-tools",
        "Bash Edit Write",
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Answered,
    Failed(String),
}

/// `exited_ok` is `None` when the probe did not finish within `TIMEOUT`.
pub fn classify(exited_ok: Option<bool>, stdout: &str, stderr: &str) -> Outcome {
    match exited_ok {
        Some(true) => Outcome::Answered,
        None => Outcome::Failed(format!(
            "zcode -p did not answer within {} s",
            TIMEOUT.as_secs()
        )),
        Some(false) => {
            let lines = || stderr.lines().chain(stdout.lines()).map(str::trim);
            let reason = lines()
                .find_map(|l| {
                    l.split_once("ProviderBusinessError:")
                        .map(|(_, r)| r.trim())
                })
                .or_else(|| lines().find(|l| !l.is_empty()))
                .unwrap_or("zcode -p exited with an error and printed nothing");
            Outcome::Failed(reason.chars().take(REASON_MAX).collect())
        }
    }
}

/// Runs the probe with `program` from `cwd`; blocks for up to `TIMEOUT`.
pub fn run(program: &Path, cwd: &Path) -> Outcome {
    let mut cmd = crate::spawn::command(program);
    cmd.args(argv()).current_dir(cwd);
    match crate::spawn::output_within(cmd, TIMEOUT) {
        Ok(Some(out)) => classify(
            Some(out.status.success()),
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
        ),
        Ok(None) => classify(None, "", ""),
        Err(e) => Outcome::Failed(format!("starting {}: {e}", program.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `zcode -p` 0.16.9 printed on an account whose quota was spent.
    const SPENT: &str = "\nZCode Built-in missing\nProviderBusinessError: [1310][Weekly/Monthly Limit \
         Exhausted. Your limit will reset at 2026-10-24 22:18:34][202610221259195fa55e167c7a40e7]\n    \
         at detectProviderBusinessError (zcode.cjs:2073:11154)\n";

    #[test]
    fn spent_quota_names_the_provider_error() {
        let Outcome::Failed(why) = classify(Some(false), "", SPENT) else {
            panic!("a spent quota fails the probe");
        };
        assert!(
            why.starts_with("[1310][Weekly/Monthly Limit Exhausted."),
            "{why}"
        );
        assert!(why.chars().count() <= REASON_MAX);
    }

    #[test]
    fn answer_timeout_and_other_failures() {
        assert_eq!(classify(Some(true), "OK", ""), Outcome::Answered);
        assert!(matches!(classify(None, "", ""), Outcome::Failed(w) if w.contains("90 s")));
        assert_eq!(
            classify(Some(false), "", "\nnot logged in\n"),
            Outcome::Failed("not logged in".into())
        );
        assert!(
            matches!(classify(Some(false), "", ""), Outcome::Failed(w) if w.contains("printed nothing"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_program_without_tools() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("zcode");
        std::fs::write(
            &script,
            "#!/bin/sh\necho \"$*\" > args\necho 'ProviderBusinessError: [1310][limit]' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            run(&script, dir.path()),
            Outcome::Failed("[1310][limit]".into())
        );
        let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
        assert!(
            args.contains("--disallowed-tools Bash Edit Write"),
            "{args}"
        );
    }
}
