use std::path::{Path, PathBuf};
use std::time::Duration;

/// 15s covers a cold start on a loaded box without letting a hung child hold a
/// boot-time task open forever.
const ADD_TIMEOUT: Duration = Duration::from_secs(15);
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

fn canonical_houston_table(root: &toml_edit::Table) -> Result<&toml_edit::Table, String> {
    root.get("mcp_servers")
        .and_then(toml_edit::Item::as_table)
        .and_then(|servers| servers.get(crate::mcp_server::SERVER_NAME))
        .and_then(toml_edit::Item::as_table)
        .ok_or_else(|| {
            "Codex config has no canonical mcp_servers.houston table — leaving it alone".to_string()
        })
}

fn canonical_houston_table_mut(
    document: &mut toml_edit::DocumentMut,
) -> Result<&mut toml_edit::Table, String> {
    document
        .as_table_mut()
        .get_mut("mcp_servers")
        .and_then(toml_edit::Item::as_table_mut)
        .and_then(|servers| servers.get_mut(crate::mcp_server::SERVER_NAME))
        .and_then(toml_edit::Item::as_table_mut)
        .ok_or_else(|| {
            "Codex config has no canonical mcp_servers.houston table — leaving it alone".to_string()
        })
}

fn parse_edit_document(contents: &str) -> Result<toml_edit::ImDocument<String>, String> {
    toml_edit::ImDocument::parse(contents.to_owned())
        .map_err(|e| format!("Codex config.toml is not valid TOML ({e}) — leaving it alone"))
}

fn collect_value_spans(table: &toml_edit::Table, spans: &mut Vec<std::ops::Range<usize>>) {
    for (_, item) in table.iter() {
        match item {
            toml_edit::Item::Value(value) => {
                if let Some(span) = value.span() {
                    spans.push(span);
                }
            }
            toml_edit::Item::Table(table) => collect_value_spans(table, spans),
            toml_edit::Item::ArrayOfTables(array) => {
                for table in array.iter() {
                    collect_value_spans(table, spans);
                }
            }
            toml_edit::Item::None => {}
        }
    }
}

fn collect_table_starts(table: &toml_edit::Table, starts: &mut Vec<usize>) {
    if let Some(span) = table.span() {
        starts.push(span.start);
    }
    for (_, item) in table.iter() {
        match item {
            toml_edit::Item::Table(table) => collect_table_starts(table, starts),
            toml_edit::Item::ArrayOfTables(array) => {
                for table in array.iter() {
                    collect_table_starts(table, starts);
                }
            }
            _ => {}
        }
    }
}

fn marker_line_start(contents: &str, position: usize) -> usize {
    contents[..position]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0)
}

fn marker_line_end(contents: &str, position: usize) -> usize {
    contents[position..]
        .find('\n')
        .map(|index| position + index + 1)
        .unwrap_or(contents.len())
}

fn marker_positions(
    contents: &str,
    marker: &str,
    value_spans: &[std::ops::Range<usize>],
    section_start: usize,
    section_end: usize,
) -> Vec<usize> {
    let mut positions = Vec::new();
    let Some(section) = contents.get(section_start..section_end) else {
        return positions;
    };
    for (offset, _) in section.match_indices(marker) {
        let position = section_start + offset;
        if value_spans.iter().any(|span| span.contains(&position)) {
            continue;
        }
        let line_start = marker_line_start(contents, position);
        let line_end = marker_line_end(contents, position);
        let line = contents[line_start..line_end].trim();
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line == marker {
            positions.push(position);
        }
    }
    positions.sort_unstable();
    positions.dedup();
    positions
}

fn managed_marker_lines(
    contents: &str,
    document: &toml_edit::ImDocument<String>,
    table: &toml_edit::Table,
    timeout: Option<&toml_edit::Item>,
) -> Result<Option<Vec<std::ops::Range<usize>>>, String> {
    let table_span = table
        .span()
        .ok_or_else(|| "Codex Houston table has no source span — leaving it alone".to_string())?;
    let mut starts = Vec::new();
    collect_table_starts(document.as_table(), &mut starts);
    let section_end = starts
        .into_iter()
        .filter(|start| *start > table_span.start)
        .min()
        .unwrap_or(contents.len());
    let mut value_spans = Vec::new();
    collect_value_spans(document.as_table(), &mut value_spans);
    let opens = marker_positions(
        contents,
        CODEX_TIMEOUT_OPEN,
        &value_spans,
        table_span.start,
        section_end,
    );
    let closes = marker_positions(
        contents,
        CODEX_TIMEOUT_CLOSE,
        &value_spans,
        table_span.start,
        section_end,
    );
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
        (Some(open), Some(close)) => {
            let timeout_span = timeout
                .and_then(toml_edit::Item::span)
                .ok_or_else(|| {
                    "Codex config Houston timeout markers do not surround a timeout setting — leaving it alone"
                        .to_string()
                })?;
            if open >= timeout_span.start || close <= timeout_span.end {
                return Err(
                    "Codex config Houston timeout markers do not surround the timeout setting — leaving it alone"
                        .to_string(),
                );
            }
            Ok(Some(vec![
                marker_line_start(contents, open)..marker_line_end(contents, open),
                marker_line_start(contents, close)..marker_line_end(contents, close),
            ]))
        }
    }
}

fn remove_marker_lines(contents: &str, ranges: &[std::ops::Range<usize>]) -> String {
    let mut updated = contents.to_string();
    for range in ranges.iter().rev() {
        updated.replace_range(range.clone(), "");
    }
    updated
}

fn render_document(original: &str, document: toml_edit::DocumentMut) -> String {
    let newline = if original.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut rendered = document.to_string();
    if newline == "\r\n" {
        rendered = rendered.replace('\n', "\r\n");
    }
    if !original.ends_with(newline) && rendered.ends_with(newline) {
        rendered.truncate(rendered.len() - newline.len());
    }
    rendered
}

fn ensure_timeout_text(contents: &str) -> Result<(String, TimeoutAction), String> {
    let parsed = parse_edit_document(contents)?;
    let table = canonical_houston_table(parsed.as_table())?;
    let timeout = table.get("tool_timeout_sec");
    let markers = managed_marker_lines(contents, &parsed, table, timeout)?;
    let expected = crate::mcp_launch::CODEX_TOOL_TIMEOUT_SEC as i64;
    let managed_value = timeout
        .and_then(toml_edit::Item::as_value)
        .and_then(toml_edit::Value::as_integer)
        == Some(expected);

    if let Some(ranges) = markers {
        if managed_value {
            return Ok((contents.to_string(), TimeoutAction::AlreadyManaged));
        }
        return Ok((
            remove_marker_lines(contents, &ranges),
            TimeoutAction::UserOverride,
        ));
    }

    if timeout.is_some() {
        return Ok((contents.to_string(), TimeoutAction::PreservedUser));
    }

    let mut document = parsed.into_mut();
    let table = canonical_houston_table_mut(&mut document)?;
    let mut timeout = toml_edit::value(expected);
    timeout
        .as_value_mut()
        .expect("toml_edit::value creates a value item")
        .decor_mut()
        .set_suffix(format!("\n{CODEX_TIMEOUT_CLOSE}"));
    table.insert("tool_timeout_sec", timeout);
    table
        .key_mut("tool_timeout_sec")
        .expect("inserted timeout key exists")
        .leaf_decor_mut()
        .set_prefix(format!("{CODEX_TIMEOUT_OPEN}\n"));
    Ok((render_document(contents, document), TimeoutAction::Added))
}

fn validate_transform(
    before: &str,
    after: &str,
    refreshed_endpoint: Option<&str>,
) -> Result<(), String> {
    let mut before_value: toml::Value = before
        .parse()
        .map_err(|e| format!("Codex config.toml is not valid TOML before transformation ({e})"))?;
    let mut after_value: toml::Value = after
        .parse()
        .map_err(|e| format!("Codex config.toml is not valid TOML after transformation ({e})"))?;
    let before_timeout = take_houston_field(&mut before_value, "tool_timeout_sec");
    let after_timeout = take_houston_field(&mut after_value, "tool_timeout_sec");
    match (&before_timeout, &after_timeout) {
        (None, Some(toml::Value::Integer(value)))
            if *value == crate::mcp_launch::CODEX_TOOL_TIMEOUT_SEC as i64 => {}
        (Some(before), Some(after)) if before == after => {}
        (None, None) => {}
        _ => {
            return Err(
                "Codex timeout transformation changed an explicit or unexpected timeout value — leaving it alone"
                    .to_string(),
            )
        }
    }

    let before_url = take_houston_field(&mut before_value, "url");
    let after_url = take_houston_field(&mut after_value, "url");
    if let Some(endpoint) = refreshed_endpoint {
        if after_url != Some(toml::Value::String(endpoint.to_string())) {
            return Err(
                "Codex endpoint transformation did not produce the requested Houston URL — leaving it alone"
                    .to_string(),
            );
        }
    } else if before_url != after_url {
        return Err(
            "Codex timeout transformation changed the Houston endpoint — leaving it alone"
                .to_string(),
        );
    }

    if before_value != after_value {
        return Err(
            "Codex MCP transformation changed unrelated configuration — leaving it alone"
                .to_string(),
        );
    }
    Ok(())
}

fn take_houston_field(parsed: &mut toml::Value, key: &str) -> Option<toml::Value> {
    parsed
        .as_table_mut()?
        .get_mut("mcp_servers")?
        .as_table_mut()?
        .get_mut(crate::mcp_server::SERVER_NAME)?
        .as_table_mut()?
        .remove(key)
}

fn write_config_if_changed(path: &Path, before: &str, after: &str) -> Result<(), String> {
    if before != after {
        std::fs::write(path, after)
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    Ok(())
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

fn refresh_endpoint_text(contents: &str, port: u16) -> Result<String, String> {
    let parsed = parse_edit_document(contents)?;
    let table = canonical_houston_table(parsed.as_table())?;
    let url_item = table.get("url").ok_or_else(|| {
        "Codex Houston entry has no single-line url setting to refresh safely — leaving it alone"
            .to_string()
    })?;
    let url_span = url_item.span().ok_or_else(|| {
        "Codex Houston entry has no single-line url setting to refresh safely — leaving it alone"
            .to_string()
    })?;
    let raw_url = contents
        .get(url_span)
        .ok_or_else(|| "Codex Houston endpoint span is invalid — leaving it alone".to_string())?;
    if raw_url.contains('\r')
        || raw_url.contains('\n')
        || raw_url.starts_with("\"\"\"")
        || raw_url.starts_with("'''")
    {
        return Err(
            "Codex Houston entry has no single-line url setting to refresh safely — leaving it alone"
                .to_string(),
        );
    }
    let quote = match raw_url.as_bytes() {
        [b'"', .., b'"'] => '"',
        [b'\'', .., b'\''] => '\'',
        _ => {
            return Err(
                "Codex Houston entry has no single-line quoted url setting to refresh safely — leaving it alone"
                    .to_string(),
            )
        }
    };
    let endpoint = crate::mcp_launch::endpoint(port);
    let mut document = parsed.into_mut();
    let table = canonical_houston_table_mut(&mut document)?;
    let item = table
        .get_mut("url")
        .expect("url was present in the parsed Houston table");
    let decor = item
        .as_value()
        .expect("url must be a scalar value")
        .decor()
        .clone();
    let mut replacement: toml_edit::Item = format!("{quote}{endpoint}{quote}")
        .parse()
        .map_err(|e| format!("could not format refreshed Codex endpoint ({e})"))?;
    *replacement
        .as_value_mut()
        .expect("a quoted endpoint parses as a value")
        .decor_mut() = decor;
    *item = replacement;
    let updated = render_document(contents, document);
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
    if actual != Some(endpoint.as_str()) {
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
            let original = contents
                .as_deref()
                .expect("current entry requires config contents");
            let (updated, action) = ensure_timeout_text(original)?;
            validate_transform(original, &updated, None)?;
            write_config_if_changed(&config_path, original, &updated)?;
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
                let original = contents
                    .as_deref()
                    .expect("owned entry requires config contents");
                let refreshed = refresh_endpoint_text(original, port)?;
                let (updated, action) = ensure_timeout_text(&refreshed)?;
                let endpoint = crate::mcp_launch::endpoint(port);
                validate_transform(original, &updated, Some(&endpoint))?;
                write_config_if_changed(&config_path, original, &updated)?;
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
                let (updated, action) = ensure_timeout_text(&registered)?;
                validate_transform(&registered, &updated, None)?;
                write_config_if_changed(&config_path, &registered, &updated)?;
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
    async fn adding_timeout_preserves_crlf_and_existing_value_formatting() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "# keep\r\n[mcp_servers.houston]\r\nurl = 'http://127.0.0.1:4242/mcp'\r\nbearer_token_env_var='HOUSTON_MCP_TOKEN'\r\ncustom = [1, 2] # keep\r\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(after.starts_with(original), "{after:?}");
        assert!(
            after.contains("url = 'http://127.0.0.1:4242/mcp'"),
            "{after:?}"
        );
        assert!(after.contains(CODEX_TIMEOUT_OPEN), "{after:?}");
        assert!(after.contains(CODEX_TIMEOUT_CLOSE), "{after:?}");
        assert!(
            after
                .as_bytes()
                .windows(2)
                .filter(|pair| pair[1] == b'\n')
                .all(|pair| pair[0] == b'\r'),
            "{after:?}"
        );
    }

    #[tokio::test]
    async fn a_quoted_following_table_does_not_receive_houston_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\n\n[mcp_servers.\"other#name\"]\nurl = \"http://127.0.0.1:9000/mcp\"\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        let parsed: toml::Value = after.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["houston"]["tool_timeout_sec"],
            toml::Value::Integer(630)
        );
        assert!(!parsed["mcp_servers"]["other#name"]
            .as_table()
            .unwrap()
            .contains_key("tool_timeout_sec"));
        assert!(after.contains("[mcp_servers.\"other#name\"]"), "{after}");
    }

    #[tokio::test]
    async fn table_like_and_assignment_like_multiline_string_content_is_not_config() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\nnotes = \"\"\"\n[mcp_servers.looks_like_a_table]\ntool_timeout_sec = 90\n\"\"\"\n";
        std::fs::write(home.join("config.toml"), original).unwrap();

        run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap();
        let after = std::fs::read_to_string(home.join("config.toml")).unwrap();
        let parsed: toml::Value = after.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["houston"]["tool_timeout_sec"],
            toml::Value::Integer(630)
        );
        assert_eq!(
            parsed["mcp_servers"]["houston"]["notes"],
            toml::Value::String(
                "[mcp_servers.looks_like_a_table]\ntool_timeout_sec = 90\n".to_string()
            )
        );
    }

    #[tokio::test]
    async fn an_explicit_timeout_with_a_noncanonical_escaped_key_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = "[mcp_servers.houston]\nurl = \"http://127.0.0.1:4242/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\n\"tool_timeout_\\u0073ec\" = 90 # user choice\n";
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
    async fn failed_timeout_validation_does_not_persist_a_refreshed_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let original = format!(
            "[mcp_servers.houston]\nurl = \"http://127.0.0.1:1111/mcp\"\nbearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\n{CODEX_TIMEOUT_OPEN}\n"
        );
        std::fs::write(home.join("config.toml"), &original).unwrap();

        let err = run(home, Path::new("/nonexistent/codex"), 4242)
            .await
            .unwrap_err();
        assert!(err.contains("unclosed"), "{err}");
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            original
        );
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
