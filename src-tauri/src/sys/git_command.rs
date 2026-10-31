/// Every git process the host starts. `GIT_OPTIONAL_LOCKS=0` stops background reads such as
/// `status` from refreshing `.git/index` under `index.lock`, which would make an agent's own
/// `git add` or `git commit` fail; `spawn::git` also runs Git for Windows' real binary.
pub fn command() -> std::process::Command {
    let mut command = crate::sys::spawn::git();
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
}
