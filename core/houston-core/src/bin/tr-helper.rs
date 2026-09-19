//! The agent-facing helper: `hook`, and nothing else. The shipped app's binary
//! links a whole GUI stack, so running a hook through it costs ~40 ms of loader
//! time on the agent's blocking path; `houston-core` links none of it.
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hook") => {
            houston_core::claude_hooks::run_hook_client(&args);
            ExitCode::SUCCESS
        }
        Some("hs-mail") => {
            // The retired subcommand answers with a refusal naming its
            // replacement rather than silence: a stale launcher gets told where
            // the behaviour went.
            eprintln!(
                "hs-mail is gone: messages between panes are inbox rows; use pane_submit, or \
                 hs-pane for the CLI-only providers"
            );
            ExitCode::FAILURE
        }
        other => {
            eprintln!(
                "tr-helper: unrecognized subcommand {:?} — this binary serves only `hook`. The \
                 daemon, the window and every other subcommand live in the main Houston binary.",
                other.unwrap_or("<none>")
            );
            ExitCode::FAILURE
        }
    }
}
