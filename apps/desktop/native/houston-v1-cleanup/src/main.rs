//! Runs the v1 configuration cleanup once and prints the same JSON report the host
//! exposes to the renderer.

use std::path::PathBuf;
use std::process::ExitCode;

use houston_v1_cleanup::sys::host_env::HostEnv;
use houston_v1_cleanup::sys::paths::validate_channel;
use houston_v1_cleanup::v1_cleanup::{run_for_host, Report, Target};

struct Args {
    home: PathBuf,
    channel: Option<String>,
}

fn usage() -> &'static str {
    "usage: houston-v1-cleanup [--home <directory>] [--channel <name>]\n\
     \n\
     Removes Houston 1 hook and MCP entries for the chosen channel and prints a JSON report.\n\
     Home defaults to $HOME (or %USERPROFILE%); the channel defaults to $HOUSTON_CHANNEL."
}

fn parse_args(mut values: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut channel = match std::env::var("HOUSTON_CHANNEL") {
        Ok(value) => validate_channel(&value)?,
        Err(_) => None,
    };

    while let Some(value) = values.next() {
        match value.as_str() {
            "--home" => {
                let path = values.next().ok_or("--home expects a directory")?;
                home = Some(PathBuf::from(path));
            }
            "--channel" => {
                let name = values.next().ok_or("--channel expects a channel name")?;
                channel = validate_channel(&name)?;
            }
            "--help" | "-h" => return Err(usage().to_string()),
            other => return Err(format!("unknown argument {other:?}\n{}", usage())),
        }
    }

    let home = home.ok_or_else(|| {
        "cannot resolve the user's home directory; pass --home <directory>".to_string()
    })?;
    Ok(Args { home, channel })
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("houston-v1-cleanup: {message}");
            return ExitCode::from(2);
        }
    };

    let target = Target::from_env(&HostEnv::capture(), &args.home, args.channel.as_deref());
    let outcome = run_for_host(&target);
    let report = Report::from(&outcome);
    match serde_json::to_writer(std::io::stdout(), &report) {
        Ok(()) => {
            println!();
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("houston-v1-cleanup: could not serialize the report: {error}");
            ExitCode::FAILURE
        }
    }
}
