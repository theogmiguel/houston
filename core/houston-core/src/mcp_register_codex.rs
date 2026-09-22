use std::path::{Path, PathBuf};
use std::time::Duration;

/// 15s covers a cold start on a loaded box without letting a hung child hold a
/// boot-time task open forever.
const ADD_TIMEOUT: Duration = Duration::from_secs(15);
const HOUSTON_TABLE_HEADER: &str = "[mcp_servers.houston]";
const CODEX_TIMEOUT_OPEN: &str = "# >>> houston managed (codex timeout) >>>";
const CODEX_TIMEOUT_CLOSE: &str = "# <<< houston managed (codex timeout) <<<";

pub fn registration_args(port: u16) -> Vec<String> {
    vec![
        "mcp".to_string(),
        "add".to_string(),
        crate::mcp_server::SERVER_NAME.to_string(),
        "--url".to_string(),
        crate::mcp_launch::endpoint(port),
        "--bearer-token-env-var".to_string(),
        crate::mcp_launch::CODEX_TOKEN_ENV.to_string(),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Current,
    Register,
    Skip(String),
}

fn is_houston_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    let Some((port_str, suffix)) = rest.split_once('/') else {
        return false;
    };
    suffix == "mcp" && !port_str.is_empty() && port_str.chars().all(|c| c.is_ascii_digit())
}

fn parse_houston_port(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let (port_str, suffix) = rest.split_once('/')?;
    if suffix != "mcp" {
        return None;
    }
    port_str.parse::<u16>().ok()
}

pub fn decide(contents: Option<&str>, port: u16) -> Decision {
    let Some(text) = contents else {
        return Decision::Register;
    };
    let parsed: toml::Value = match text.parse() {
        Ok(v) => v,
        Err(e) => {
            return Decision::Skip(format!(
                "Codex config.toml is not valid TOML ({e}); expected a table with \
                 an optional `mcp_servers` table — leaving it alone"
            ));
        }
    };
    let Some(root_table) = parsed.as_table() else {
        return Decision::Skip(
            "Codex config.toml root is not a table — leaving it alone".to_string(),
        );
    };
    match root_table.get("mcp_servers") {
        None => Decision::Register,
        Some(toml::Value::Table(servers)) => {
            let server_name = crate::mcp_server::SERVER_NAME;
            let Some(houston_entry) = servers.get(server_name) else {
                return Decision::Register;
            };
            let Some(table) = houston_entry.as_table() else {
                return Decision::Skip(format!(
                    "codex `mcp_servers.{server_name}` exists and is not Houston's (not a table) — leaving it alone"
                ));
            };
            let url = table.get("url").and_then(|v| v.as_str());
            let bearer_env = table.get("bearer_token_env_var").and_then(|v| v.as_str());

            let is_ours = url.map(is_houston_url).unwrap_or(false)
                && bearer_env == Some(crate::mcp_launch::CODEX_TOKEN_ENV);

            if is_ours {
                let existing_port = url.and_then(parse_houston_port);
                if existing_port == Some(port) {
                    Decision::Current
                } else {
                    Decision::Register
                }
            } else {
                let keys = table.keys().cloned().collect::<Vec<_>>().join(", ");
                Decision::Skip(format!(
                    "codex `mcp_servers.{server_name}` exists and is not Houston's (url={url:?}, keys=[{keys}]) — leaving it alone"
                ))
            }
        }
        Some(other) => Decision::Skip(format!(
            "Codex config `mcp_servers` is {}, expected a table — leaving it alone",
            kind_of(other)
        )),
    }
}

fn kind_of(v: &toml::Value) -> &'static str {
    match v {
        toml::Value::String(_) => "a string",
        toml::Value::Integer(_) => "an integer",
        toml::Value::Float(_) => "a float",
        toml::Value::Boolean(_) => "a boolean",
        toml::Value::Datetime(_) => "a datetime",
        toml::Value::Array(_) => "an array",
        toml::Value::Table(_) => "a table",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutAction {
    AlreadyManaged,
    Added,
    PreservedUser,
    UserOverride,
}

fn table_header(line: &str) -> Option<&str> {
    let without_comment = line.split_once('#').map(|(head, _)| head).unwrap_or(line);
    let trimmed = without_comment.trim();
    let body = if trimmed.starts_with("[[") {
        trimmed.strip_prefix("[[")?.strip_suffix("]]")?
    } else {
        trimmed.strip_prefix('[')?.strip_suffix(']')?
    };
    let body = body.trim();
    if body.is_empty()
        || !body
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-.".contains(character))
    {
        return None;
    }
    Some(trimmed)
}

fn houston_section(lines: &[String]) -> Result<(usize, usize), String> {
    let Some(start) = lines
        .iter()
        .position(|line| table_header(line) == Some(HOUSTON_TABLE_HEADER))
    else {
        return Err(format!(
            "Codex config has a Houston entry but no canonical {HOUSTON_TABLE_HEADER} table — leaving it alone"
        ));
    };
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find_map(|(index, line)| table_header(line).map(|_| index))
        .unwrap_or(lines.len());
    Ok((start, end))
}

fn is_assignment(line: &str, key: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        return false;
    }
    trimmed
        .split_once('=')
        .map(|(left, _)| {
            let left = left.trim();
            left == key
                || left
                    .strip_prefix('"')
                    .and_then(|value| value.strip_suffix('"'))
                    == Some(key)
                || left
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
                    == Some(key)
        })
        .unwrap_or(false)
}

fn marker_bounds(
    lines: &[String],
    start: usize,
    end: usize,
) -> Result<Option<(usize, usize)>, String> {
    let opens: Vec<usize> = (start + 1..end)
        .filter(|&index| lines[index].trim() == CODEX_TIMEOUT_OPEN)
        .collect();
    let closes: Vec<usize> = (start + 1..end)
        .filter(|&index| lines[index].trim() == CODEX_TIMEOUT_CLOSE)
        .collect();
    if opens.len() > 1 || closes.len() > 1 {
        return Err(
            "Codex config has multiple Houston timeout marker blocks — leaving it alone"
                .to_string(),
        );
    }
    match (opens.first().copied(), closes.first().copied()) {
        (None, None) => Ok(None),
        (Some(_), None) => Err(
            "Codex config has an unclosed Houston timeout marker — leaving it alone".to_string(),
        ),
        (None, Some(_)) => Err(
            "Codex config has a Houston timeout closing marker without an opener — leaving it alone"
                .to_string(),
        ),
        (Some(open), Some(close)) if open < close => Ok(Some((open, close))),
        (Some(_), Some(_)) => Err(
            "Codex config has reversed Houston timeout markers — leaving it alone".to_string(),
        ),
    }
}

fn split_config(text: &str) -> (Vec<String>, &'static str, bool) {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    (
        text.lines().map(str::to_string).collect(),
        newline,
        text.ends_with('\n'),
    )
}

fn join_config(lines: &[String], newline: &str, trailing_newline: bool) -> String {
    let mut out = lines.join(newline);
    if trailing_newline {
        out.push_str(newline);
    }
    out
}

fn houston_entry(parsed: &toml::Value) -> Option<&toml::Value> {
    parsed
        .as_table()?
        .get("mcp_servers")?
        .as_table()?
        .get(crate::mcp_server::SERVER_NAME)
}

fn houston_timeout_value(parsed: &toml::Value) -> Option<&toml::Value> {
    houston_entry(parsed)?.as_table()?.get("tool_timeout_sec")
}

fn insert_managed_timeout(lines: &mut Vec<String>, start: usize, end: usize) {
    let mut insertion = end;
    while insertion > start + 1 && lines[insertion - 1].trim().is_empty() {
        insertion -= 1;
    }
    lines.splice(
        insertion..insertion,
        [
            CODEX_TIMEOUT_OPEN.to_string(),
            format!(
                "tool_timeout_sec = {}",
                crate::mcp_launch::CODEX_TOOL_TIMEOUT_SEC
            ),
            CODEX_TIMEOUT_CLOSE.to_string(),
        ],
    );
}

fn ensure_timeout_text(contents: &str) -> Result<(String, TimeoutAction), String> {
    let parsed: toml::Value = contents.parse().map_err(|e| {
        format!("Codex config.toml is not valid TOML after registration ({e}) — leaving it alone")
    })?;
    if houston_entry(&parsed)
        .and_then(|entry| entry.as_table())
        .is_none()
    {
        return Err(
            "Codex config has no Houston `mcp_servers.houston` table after registration — leaving it alone"
                .to_string(),
        );
    }

    let (mut lines, newline, trailing_newline) = split_config(contents);
    let (start, end) = houston_section(&lines)?;
    let timeout_lines: Vec<usize> = (start + 1..end)
        .filter(|&index| is_assignment(&lines[index], "tool_timeout_sec"))
        .collect();
    let markers = marker_bounds(&lines, start, end)?;
    let expected = crate::mcp_launch::CODEX_TOOL_TIMEOUT_SEC as i64;
    let managed_value = matches!(
        houston_timeout_value(&parsed),
        Some(toml::Value::Integer(value)) if *value == expected
    );

    if let Some((open, close)) = markers {
        if timeout_lines.len() > 1
            || timeout_lines
                .first()
                .map(|index| *index <= open || *index >= close)
                .unwrap_or(true)
        {
            return Err(
                "Codex config Houston timeout marker does not contain exactly one timeout setting — leaving it alone"
                    .to_string(),
            );
        }
        if managed_value {
            return Ok((contents.to_string(), TimeoutAction::AlreadyManaged));
        }
        lines.remove(close);
        lines.remove(open);
        return Ok((
            join_config(&lines, newline, trailing_newline),
            TimeoutAction::UserOverride,
        ));
    }

    if !timeout_lines.is_empty() {
        return Ok((contents.to_string(), TimeoutAction::PreservedUser));
    }

    insert_managed_timeout(&mut lines, start, end);
    Ok((
        join_config(&lines, newline, trailing_newline),
        TimeoutAction::Added,
    ))
}

fn persist_timeout(path: &Path, contents: &str) -> Result<TimeoutAction, String> {
    let (updated, action) = ensure_timeout_text(contents)?;
    if updated != contents {
        std::fs::write(path, updated)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    Ok(action)
}

fn owned_houston_port(contents: &str) -> Option<u16> {
    let parsed: toml::Value = contents.parse().ok()?;
    let entry = parsed
        .as_table()?
        .get("mcp_servers")?
        .as_table()?
        .get(crate::mcp_server::SERVER_NAME)?
        .as_table()?;
    let url = entry.get("url")?.as_str()?;
    let bearer_env = entry.get("bearer_token_env_var")?.as_str()?;
    if bearer_env == crate::mcp_launch::CODEX_TOKEN_ENV {
        parse_houston_port(url)
    } else {
        None
    }
}

fn replace_assignment_value(line: &str, key: &str, value: &str) -> Option<String> {
    if !is_assignment(line, key) {
        return None;
    }
    let equals = line.find('=')?;
    let rhs = &line[equals + 1..];
    let leading_len = rhs.len() - rhs.trim_start().len();
    let leading = &rhs[..leading_len];
    let rest = &rhs[leading_len..];
    let comment_index = rest.find('#').unwrap_or(rest.len());
    let before_comment = &rest[..comment_index];
    let trailing_len = before_comment.len() - before_comment.trim_end().len();
    let trailing = &before_comment[before_comment.len() - trailing_len..];
    let comment = &rest[comment_index..];
    Some(format!(
        "{}={}{}{}{}",
        &line[..equals],
        leading,
        crate::agent_hooks::toml_string(value),
        trailing,
        comment
    ))
}

fn refresh_endpoint_text(contents: &str, port: u16) -> Result<String, String> {
    let (mut lines, newline, trailing_newline) = split_config(contents);
    let (start, end) = houston_section(&lines)?;
    let url_lines: Vec<usize> = (start + 1..end)
        .filter(|&index| is_assignment(&lines[index], "url"))
        .collect();
    if url_lines.len() != 1 {
        return Err(
            "Codex Houston entry has no single-line `url` setting to refresh safely — leaving it alone"
                .to_string(),
        );
    }
    let url_index = url_lines[0];
    lines[url_index] =
        replace_assignment_value(&lines[url_index], "url", &crate::mcp_launch::endpoint(port))
            .expect("url_lines contains an url assignment");
    let updated = join_config(&lines, newline, trailing_newline);
    let parsed: toml::Value = updated.parse().map_err(|e| {
        format!("refreshing Codex Houston endpoint produced invalid TOML ({e}) — leaving it alone")
    })?;
    let actual = parsed
        .as_table()
        .and_then(|root| root.get("mcp_servers"))
        .and_then(toml::Value::as_table)
        .and_then(|servers| servers.get(crate::mcp_server::SERVER_NAME))
        .and_then(toml::Value::as_table)
        .and_then(|entry| entry.get("url"))
        .and_then(toml::Value::as_str);
    if actual != Some(crate::mcp_launch::endpoint(port).as_str()) {
        return Err(
            "Codex Houston endpoint did not refresh to the requested port — leaving it alone"
                .to_string(),
        );
    }
    Ok(updated)
}

pub async fn run(codex_home: &Path, codex_bin: &Path, port: u16) -> Result<String, String> {
    let config_path = codex_home.join("config.toml");
    let contents = match std::fs::read_to_string(&config_path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "could not read {}: {e} — skipping Codex MCP self-registration",
                config_path.display()
            ));
        }
    };
    match decide(contents.as_deref(), port) {
        Decision::Current => {
            let action = persist_timeout(&config_path, contents.as_deref().unwrap_or_default())?;
            Ok(format!(
                "codex user-scope MCP entry `{}` already current; {}",
                crate::mcp_server::SERVER_NAME,
                timeout_action_message(action)
            ))
        }
        Decision::Skip(reason) => Err(reason),
        Decision::Register => {
            if let Some(existing_port) = contents.as_deref().and_then(owned_houston_port) {
                // `codex mcp add` rewrites Houston's table and drops extra fields, so
                // refresh only its endpoint and leave the user's table formatting intact.
                let refreshed = refresh_endpoint_text(
                    contents
                        .as_deref()
                        .expect("owned entry requires config contents"),
                    port,
                )?;
                if refreshed != contents.as_deref().unwrap_or_default() {
                    std::fs::write(&config_path, &refreshed).map_err(|e| {
                        format!("could not write refreshed {}: {e}", config_path.display())
                    })?;
                }
                let action = persist_timeout(&config_path, &refreshed)?;
                return Ok(format!(
                    "refreshed codex user-scope MCP entry `{}` from port {existing_port} to {port}; {}",
                    crate::mcp_server::SERVER_NAME,
                    timeout_action_message(action)
                ));
            }
            let output = tokio::time::timeout(
                ADD_TIMEOUT,
                crate::spawn::tokio_command(codex_bin)
                    .args(registration_args(port))
                    .env("CODEX_HOME", codex_home)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| {
                format!(
                    "`codex mcp add` did not finish within {}s — killed; \
                     registration will retry next boot",
                    ADD_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("could not run `{}`: {e}", codex_bin.display()))?;
            if output.status.success() {
                let registered = std::fs::read_to_string(&config_path).map_err(|e| {
                    format!(
                        "`codex mcp add` succeeded but {} could not be read: {e}",
                        config_path.display()
                    )
                })?;
                let action = persist_timeout(&config_path, &registered)?;
                Ok(format!(
                    "registered `{}` in codex user scope; {} (flagless `codex` in Houston \
                     panes now connects)",
                    crate::mcp_server::SERVER_NAME,
                    timeout_action_message(action)
                ))
            } else {
                Err(format!(
                    "`codex mcp add` exited {:?}: {}",
                    output.status.code(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        }
    }
}

fn timeout_action_message(action: TimeoutAction) -> &'static str {
    match action {
        TimeoutAction::AlreadyManaged => "Houston timeout already managed",
        TimeoutAction::Added => "added Houston's managed 630s tool timeout",
        TimeoutAction::PreservedUser => "preserved the user's explicit tool timeout",
        TimeoutAction::UserOverride => "preserved the user's timeout and removed Houston's markers",
    }
}

// The entry holds a literal port, so it must be refreshed every boot — but only
// on the release channel: a dev daemon writing the same file would fight the
// installed app over one `[mcp_servers.houston]`.
pub fn spawn_at_boot(port: Option<u16>) {
    match crate::paths::channel() {
        Ok(Some(name)) => {
            tracing::info!(
                "codex mcp self-registration: skipped on channel {name}: the entry \
                 holds a literal port and belongs to the release daemon"
            );
            return;
        }
        Err(e) => {
            tracing::warn!("codex mcp self-registration: channel resolution failed ({e}); skipped");
            return;
        }
        Ok(None) => {}
    }

    let Some(port) = port else {
        tracing::warn!("codex mcp self-registration: no bound port; skipped");
        return;
    };

    tokio::spawn(async move {
        let codex_home = match std::env::var_os("CODEX_HOME") {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => match crate::agent_hooks::ConfigHome::from_env() {
                Ok(h) => h.home.join(".codex"),
                Err(e) => {
                    tracing::warn!("codex mcp self-registration: no home dir ({e}); skipped");
                    return;
                }
            },
        };

        let Some(codex_bin) = crate::exe_path::resolve("codex") else {
            tracing::info!("codex mcp self-registration: `codex` not found on PATH; skipped");
            return;
        };

        match run(&codex_home, &codex_bin, port).await {
            Ok(outcome) => tracing::info!("codex mcp self-registration: {outcome}"),
            Err(reason) => tracing::warn!("codex mcp self-registration: {reason}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    async fn run_stub(codex_home: &Path, stub: &Path, port: u16) -> Result<String, String> {
        let mut last = Err(String::from("unreached"));
        for _ in 0..20 {
            last = run(codex_home, stub, port).await;
            match &last {
                Err(e) if e.contains("Text file busy") => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                _ => break,
            }
        }
        last
    }

    #[test]
    fn no_file_means_register() {
        assert_eq!(decide(None, 4242), Decision::Register);
    }

    #[test]
    fn toml_without_mcp_servers_means_register() {
        let text = "model = \"o3\"\n";
        assert_eq!(decide(Some(text), 4242), Decision::Register);
    }

    #[test]
    fn other_servers_only_means_register() {
        let text = r#"
[mcp_servers.ai_memory]
url = "http://127.0.0.1:9000/mcp"
"#;
        assert_eq!(decide(Some(text), 4242), Decision::Register);
    }

    #[test]
    fn ours_current_port_means_current() {
        let text = format!(
            r#"
[mcp_servers.houston]
url = "http://127.0.0.1:4242/mcp"
bearer_token_env_var = "{}"
"#,
            crate::mcp_launch::CODEX_TOKEN_ENV
        );
        assert_eq!(decide(Some(&text), 4242), Decision::Current);
    }

    #[test]
    fn ours_other_port_means_register() {
        let text = format!(
            r#"
[mcp_servers.houston]
url = "http://127.0.0.1:5555/mcp"
bearer_token_env_var = "{}"
"#,
            crate::mcp_launch::CODEX_TOKEN_ENV
        );
        assert_eq!(decide(Some(&text), 4242), Decision::Register);
    }

    #[test]
    fn foreign_houston_skips_naming_it() {
        let text = r#"
[mcp_servers.houston]
command = "x"
args = ["--stdio"]
"#;
        match decide(Some(text), 4242) {
            Decision::Skip(reason) => {
                assert!(reason.contains("not Houston's"), "{reason}");
                assert!(reason.contains("keys=["), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn unparseable_toml_skips_naming_the_problem() {
        match decide(Some("not toml = [["), 4242) {
            Decision::Skip(reason) => {
                assert!(reason.contains("not valid TOML"), "{reason}");
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn registration_args_holds_literal_endpoint_and_env_var_name_never_token() {
        let args = registration_args(4242);
        assert_eq!(
            args,
            vec![
                "mcp",
                "add",
                "houston",
                "--url",
                "http://127.0.0.1:4242/mcp",
                "--bearer-token-env-var",
                "HOUSTON_MCP_TOKEN"
            ]
        );
        assert!(
            !args
                .iter()
                .any(|a| a.contains("tok-") || a.contains("secret")),
            "arguments must never contain a secret token"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn run_registers_via_stub_binary_and_second_run_is_current() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let stub = home.join("codex-stub.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> {}/argv.txt\n\
                 printf '%s\\n' '[mcp_servers.houston]' 'url = \"http://127.0.0.1:4242/mcp\"' 'bearer_token_env_var = \"HOUSTON_MCP_TOKEN\"' > {}/config.toml\n",
                home.display(),
                home.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let first = run_stub(home, &stub, 4242).await.unwrap();
        assert!(first.contains("registered"), "{first}");
        let argv = std::fs::read_to_string(home.join("argv.txt")).unwrap();
        assert!(argv.contains("http://127.0.0.1:4242/mcp"), "{argv}");
        assert!(argv.contains("HOUSTON_MCP_TOKEN"), "{argv}");

        let second = run_stub(home, &stub, 4242).await.unwrap();
        assert!(second.contains("already current"), "{second}");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn initial_registration_adds_a_managed_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let stub = home.join("codex-stub.sh");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\nprintf '%s\\n' 'model = \"gpt-5.6-luna\"' '' \\
                 '[mcp_servers.other]' 'url = \"http://127.0.0.1:9000/mcp\"' '' \\
                 '[mcp_servers.houston]' 'url = \"http://127.0.0.1:4242/mcp\"' \\
                 'bearer_token_env_var = \"HOUSTON_MCP_TOKEN\"' > {}/config.toml\n",
                home.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        run_stub(home, &stub, 4242).await.unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(after.contains(CODEX_TIMEOUT_OPEN), "{after}");
        assert!(after.contains("tool_timeout_sec = 630"), "{after}");
        assert!(after.contains(CODEX_TIMEOUT_CLOSE), "{after}");
        assert!(after.contains("[mcp_servers.other]"), "{after}");
        assert!(after.contains("model = \"gpt-5.6-luna\""), "{after}");
    }

    #[tokio::test]
    async fn current_entry_adds_a_managed_timeout_without_rewriting_other_lines() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "# keep this comment\nmodel = \"gpt-5.6-luna\"\n\n[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\" # keep endpoint comment\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\ncustom = \"keep\"\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(after.starts_with(original), "{after}");
        assert!(after.contains(CODEX_TIMEOUT_OPEN), "{after}");
        assert!(after.contains("tool_timeout_sec = 630"), "{after}");
        assert!(after.contains(CODEX_TIMEOUT_CLOSE), "{after}");
    }

    #[tokio::test]
    async fn an_explicit_current_timeout_is_left_exactly_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\ntool_timeout_sec = 90 # user choice\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn a_refreshed_port_preserves_the_entry_and_adds_only_the_managed_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "# keep this comment\nmodel = \"gpt-5.6-luna\"\n\n[mcp_servers.other]\nurl = \"http://127.0.0.1:9000/mcp\"\n\n[mcp_servers.houston]\nurl = \"http://127.0.0.1:1111/mcp\" # refresh this\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\ncustom = \"keep\"\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(
            after.contains("url = \"http://127.0.0.1:4242/mcp\" # refresh this"),
            "{after}"
        );
        assert!(!after.contains("127.0.0.1:1111"), "{after}");
        assert!(
            after.contains("[mcp_servers.other]\nurl = \"http://127.0.0.1:9000/mcp\""),
            "{after}"
        );
        assert!(after.contains("custom = \"keep\""), "{after}");
        assert!(after.contains(CODEX_TIMEOUT_OPEN), "{after}");
        assert!(after.contains("tool_timeout_sec = 630"), "{after}");
    }

    #[tokio::test]
    async fn a_refreshed_port_preserves_an_explicit_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "[mcp_servers.houston]\nurl = \"http://127.0.0.1:1111/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\ntool_timeout_sec = 90 # user choice\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(
            after.contains("url = \"http://127.0.0.1:4242/mcp\""),
            "{after}"
        );
        assert!(
            after.contains("tool_timeout_sec = 90 # user choice"),
            "{after}"
        );
        assert!(!after.contains(CODEX_TIMEOUT_OPEN), "{after}");
    }

    #[tokio::test]
    async fn changing_a_managed_timeout_to_a_user_value_removes_only_our_markers() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = format!(
            "[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\n{CODEX_TIMEOUT_OPEN}\ntool_timeout_sec = 90 # user choice\n{CODEX_TIMEOUT_CLOSE}\ncustom = \"keep\"\n"
        );
        std::fs::write(home.join("config.toml"), &original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert_eq!(
            after,
            "[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\ntool_timeout_sec = 90 # user choice\ncustom = \"keep\"\n"
        );
    }

    #[tokio::test]
    async fn a_foreign_entry_is_not_changed_during_registration() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "[mcp_servers.houston]\ncommand = \"someone-else\"\ntool_timeout_sec = 90\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        let err = run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap_err();
        assert!(err.contains("not Houston's"), "{err}");
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            original
        );
    }
}
