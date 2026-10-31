//! The one seam to `wsl.exe`. Every in-distro command is `-d <distro> --exec <argv...>`:
//! after `--`, `wsl.exe` hands argv to a login shell that parses it a second time.

use super::distros::decode;

pub const WSL_EXE: &str = "wsl.exe";

#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// `exit code N`, or `killed` when the process ended without one.
pub fn exit_text(code: Option<i32>) -> String {
    code.map_or_else(|| "killed".to_string(), |code| format!("exit code {code}"))
}

/// A failed run for an error message: the command, how it ended and what it said.
/// `wsl.exe` prints its own errors on stdout, so stdout is quoted unless it may carry
/// a secret. Output is UTF-16 when `wsl.exe` itself wrote it.
pub fn failure(argv: &[String], out: &RunOutput, quote_stdout: bool) -> String {
    let stdout = if quote_stdout {
        decode(&out.stdout)
    } else {
        String::new()
    };
    let said = format!(
        "{}
{}",
        stdout.trim(),
        decode(&out.stderr).trim()
    );
    let said = match said.trim() {
        "" => {
            let retry = match argv {
                [flag, distro, ..] if flag == "-d" => format!("{WSL_EXE} -d {distro}"),
                _ => describe(argv),
            };
            format!("it printed nothing; run `{retry}` in a terminal to see why")
        }
        said => said.to_string(),
    };
    format!(
        "{} ended with {}: {said}",
        describe(argv),
        exit_text(out.code)
    )
}

/// For error messages; no argv built here carries a secret.
pub fn describe(argv: &[String]) -> String {
    format!("{WSL_EXE} {}", argv.join(" "))
}

pub fn list() -> Vec<String> {
    vec!["-l".into(), "-v".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> RunOutput {
        RunOutput {
            code,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn a_failure_names_the_command_and_never_ends_empty() {
        let argv = list();
        let utf16: Vec<u8> = "Wsl/Service/E_UNEXPECTED\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();

        let said = failure(&argv, &output(Some(-1), b"", &utf16), true);
        assert_eq!(
            said,
            format!(
                "{} ended with exit code -1: Wsl/Service/E_UNEXPECTED",
                describe(&argv)
            )
        );

        let said = failure(&argv, &output(None, b"", b""), true);
        assert!(
            said.contains("ended with killed: it printed nothing"),
            "{said}"
        );
        assert!(
            said.ends_with("run `wsl.exe -l -v` in a terminal to see why"),
            "{said}"
        );

        let said = failure(&argv, &output(Some(1), b"tok-SECRET", b""), false);
        assert!(
            !said.contains("tok-SECRET") && said.contains("printed nothing"),
            "{said}"
        );
    }

    #[test]
    fn the_distro_list_flag_uses_exec() {
        assert_eq!(list(), ["-l", "-v"]);
    }
}
