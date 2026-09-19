use anyhow::{Context, Result};
use houston_protocol as proto;
use std::path::{Path, PathBuf};

use crate::agent_hooks::{toml_string, ConfigHome};

fn opencode_config_path(home: &ConfigHome) -> PathBuf {
    let dir = home.config_dir().join("opencode");
    let plain = dir.join("opencode.json");
    if plain.exists() {
        return plain;
    }
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    plain
}

fn strip_jsonc_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let bytes = line.as_bytes();
        let mut in_string = false;
        let mut escaped = false;
        let mut cut = line.len();
        for i in 0..bytes.len() {
            let c = bytes[i];
            if escaped {
                escaped = false;
                continue;
            }
            match c {
                b'\\' if in_string => escaped = true,
                b'"' => in_string = !in_string,
                b'/' if !in_string && i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                    cut = i;
                    break;
                }
                _ => {}
            }
        }
        out.push_str(&line[..cut]);
        out.push('\n');
    }
    out
}

pub const MCP_TOOLS: [proto::AgentKind; 4] = [
    proto::AgentKind::Claude,
    proto::AgentKind::Codex,
    proto::AgentKind::Opencode,
    proto::AgentKind::Cursor,
];

pub fn source_path(state_dir: &Path) -> PathBuf {
    state_dir.join("mcp").join("servers.json")
}

pub fn tool_config_path(tool: proto::AgentKind, home: &ConfigHome) -> Option<PathBuf> {
    match tool {
        proto::AgentKind::Claude => Some(home.home.join(".claude.json")),
        proto::AgentKind::Codex => Some(home.home.join(".codex").join("config.toml")),
        proto::AgentKind::Cursor => Some(home.home.join(".cursor").join("mcp.json")),
        proto::AgentKind::Opencode => Some(opencode_config_path(home)),
        _ => None,
    }
}

fn join_pairs(pairs: &[(String, String)], sep: &str, eq: &str) -> String {
    let mut out = Vec::with_capacity(pairs.len());
    for (k, v) in pairs {
        out.push(format!("{k}{eq}{v}"));
    }
    out.join(sep)
}

fn mcp_remote_target(server: &proto::McpServer) -> Option<(String, Vec<(String, String)>)> {
    if server.transport != proto::McpTransport::Stdio {
        return None;
    }
    let command = server.command.as_deref()?;
    let args = &server.args;
    let mut i = 0usize;
    if command != "mcp-remote" {
        if command != "npx" && command != "bunx" {
            return None;
        }
        while i < args.len() && (args[i] == "-y" || args[i] == "--yes") {
            i += 1;
        }
        let pkg = args.get(i)?;
        if pkg != "mcp-remote" && !pkg.starts_with("mcp-remote@") {
            return None;
        }
        i += 1;
    }
    let mut url: Option<String> = None;
    let mut headers: Vec<(String, String)> = Vec::new();
    while i < args.len() {
        let a = &args[i];
        if a == "--header" || a == "-H" {
            if let Some(pair) = args.get(i + 1) {
                if let Some(colon) = pair.find(':') {
                    let key = pair[..colon].trim().to_string();
                    let value = pair[colon + 1..].trim().to_string();
                    if !key.is_empty() {
                        headers.push((key, value));
                    }
                }
            }
            i += 2;
            continue;
        }
        if url.is_none() && (a.starts_with("http://") || a.starts_with("https://")) {
            url = Some(a.clone());
            i += 1;
            continue;
        }
        if a.starts_with("--") {
            i += 2;
            continue;
        }
        i += 1;
    }
    headers.sort();
    url.map(|u| (u, headers))
}

/// What "the same server" means: an `mcp-remote` wrapper is canonicalised down
/// to the URL it fronts, and headers/env are sorted so two tools that agree
/// cannot look different because a map iterated differently.
pub fn fingerprint(server: &proto::McpServer) -> String {
    let on = if server.enabled { "1" } else { "0" };
    if let Some((url, headers)) = mcp_remote_target(server) {
        return format!("http|{url}|{}|{on}", join_pairs(&headers, "&", "="));
    }
    match server.transport {
        proto::McpTransport::Http | proto::McpTransport::Sse => format!(
            "{}|{}|{}|{on}",
            match server.transport {
                proto::McpTransport::Http => "http",
                _ => "sse",
            },
            server.url.clone().unwrap_or_default(),
            join_pairs(&server.headers, "&", "=")
        ),
        proto::McpTransport::Stdio => format!(
            "stdio|{}|{}|{}|{}|{on}",
            server.command.clone().unwrap_or_default(),
            server.args.join(" "),
            join_pairs(&server.env, "&", "="),
            server.cwd.clone().unwrap_or_default()
        ),
    }
}

fn finish(mut server: proto::McpServer) -> proto::McpServer {
    server.env.sort();
    server.headers.sort();
    server.fingerprint = fingerprint(&server);
    server
}

fn empty_server(name: &str) -> proto::McpServer {
    proto::McpServer {
        name: name.to_string(),
        transport: proto::McpTransport::Stdio,
        command: None,
        args: Vec::new(),
        env: Vec::new(),
        url: None,
        headers: Vec::new(),
        cwd: None,
        enabled: true,
        fingerprint: String::new(),
        destinations: Vec::new(),
    }
}

fn destinations_from_json(value: Option<&serde_json::Value>) -> Vec<proto::AgentKind> {
    let Some(arr) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| serde_json::from_value::<proto::AgentKind>(v.clone()).ok())
        .collect()
}

fn pairs_from_json(value: Option<&serde_json::Value>) -> Vec<(String, String)> {
    let Some(obj) = value.and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    obj.iter()
        .map(|(k, v)| {
            let text = match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            (k.clone(), text)
        })
        .collect()
}

fn strings_from_json(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn server_from_json(name: &str, entry: &serde_json::Value) -> Option<proto::McpServer> {
    let obj = entry.as_object()?;
    let mut server = empty_server(name);

    let kind = obj
        .get("type")
        .or_else(|| obj.get("transport"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let url = obj.get("url").and_then(|v| v.as_str()).map(str::to_string);
    server.transport = match kind {
        "http" | "remote" => proto::McpTransport::Http,
        "sse" => proto::McpTransport::Sse,
        "stdio" | "local" => proto::McpTransport::Stdio,
        _ if url.is_some() => proto::McpTransport::Http,
        _ => proto::McpTransport::Stdio,
    };
    server.url = url;

    match obj.get("command") {
        Some(serde_json::Value::String(c)) => {
            server.command = Some(c.clone());
            server.args = strings_from_json(obj.get("args"));
        }
        Some(serde_json::Value::Array(parts)) => {
            let mut it = parts.iter().filter_map(|v| v.as_str());
            server.command = it.next().map(str::to_string);
            server.args = it.map(str::to_string).collect();
        }
        _ => {}
    }
    server.env = pairs_from_json(obj.get("env").or_else(|| obj.get("environment")));
    server.headers = pairs_from_json(obj.get("headers"));
    server.cwd = obj.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
    let enabled = obj.get("enabled").and_then(|v| v.as_bool());
    let disabled = obj.get("disabled").and_then(|v| v.as_bool());
    server.enabled = enabled.unwrap_or(!disabled.unwrap_or(false));
    Some(finish(server))
}

fn servers_from_json_root(root: &serde_json::Value) -> Vec<proto::McpServer> {
    let Some(obj) = root.as_object() else {
        return Vec::new();
    };
    let map = obj
        .get("mcpServers")
        .or_else(|| obj.get("mcp"))
        .or_else(|| obj.get("servers"))
        .and_then(|v| v.as_object());
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out: Vec<proto::McpServer> = map
        .iter()
        .filter_map(|(name, entry)| server_from_json(name, entry))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn pairs_from_toml(value: Option<&toml::Value>) -> Vec<(String, String)> {
    let Some(table) = value.and_then(|v| v.as_table()) else {
        return Vec::new();
    };
    table
        .iter()
        .map(|(k, v)| {
            let text = match v {
                toml::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            (k.clone(), text)
        })
        .collect()
}

fn servers_from_toml(text: &str) -> Result<Vec<proto::McpServer>> {
    let root: toml::Value = text.parse().context("parsing TOML")?;
    let Some(table) = root
        .get("mcp_servers")
        .or_else(|| root.get("mcpServers"))
        .and_then(|v| v.as_table())
    else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, entry) in table.iter() {
        let Some(entry) = entry.as_table() else {
            continue;
        };
        let mut server = empty_server(name);
        server.command = entry
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        server.args = entry
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|v| match v {
                        toml::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        server.env = pairs_from_toml(entry.get("env"));
        server.headers = pairs_from_toml(entry.get("headers"));
        server.url = entry
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        server.cwd = entry
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if server.url.is_some() && server.command.is_none() {
            server.transport = proto::McpTransport::Http;
        }
        let enabled = entry.get("enabled").and_then(|v| v.as_bool());
        let disabled = entry.get("disabled").and_then(|v| v.as_bool());
        server.enabled = enabled.unwrap_or(!disabled.unwrap_or(false));
        out.push(finish(server));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn read_tool(tool: proto::AgentKind, home: &ConfigHome) -> proto::McpToolState {
    let Some(path) = tool_config_path(tool, home) else {
        return proto::McpToolState {
            tool,
            path: String::new(),
            detected: false,
            servers: Vec::new(),
            error: Some(format!(
                "{tool:?} has no MCP config path Houston knows about"
            )),
        };
    };
    let display = path.display().to_string();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return proto::McpToolState {
                tool,
                path: display,
                detected: false,
                servers: Vec::new(),
                error: None,
            };
        }
        Err(e) => {
            return proto::McpToolState {
                tool,
                path: display,
                detected: true,
                servers: Vec::new(),
                error: Some(format!("{e}")),
            };
        }
    };
    let parsed = if tool == proto::AgentKind::Claude {
        read_claude_servers(&text)
    } else if tool == proto::AgentKind::Codex {
        servers_from_toml(&text)
    } else if text.trim().is_empty() {
        Ok(Vec::new())
    } else {
        serde_json::from_str::<serde_json::Value>(&text)
            .or_else(|_| serde_json::from_str(&strip_jsonc_comments(&text)))
            .map(|root| servers_from_json_root(&root))
            .context("parsing JSON")
    };
    match parsed {
        Ok(mut servers) => {
            servers.retain(|s| s.name != crate::mcp_server::SERVER_NAME);
            proto::McpToolState {
                tool,
                path: display,
                detected: true,
                servers,
                error: None,
            }
        }
        Err(e) => proto::McpToolState {
            tool,
            path: display,
            detected: true,
            servers: Vec::new(),
            error: Some(format!("{e:#}")),
        },
    }
}

/// Claude Code's servers out of `~/.claude.json` — **the `mcpServers` key and
/// nothing else**. Its own function, not `servers_from_json_root`,
/// so the bound is visible in one place: that helper also accepts `mcp`/`servers`.
pub fn read_claude_servers(text: &str) -> Result<Vec<proto::McpServer>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root: serde_json::Value =
        serde_json::from_str(text).context("~/.claude.json is not valid JSON")?;
    let Some(map) = root.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<proto::McpServer> = map
        .iter()
        .filter_map(|(name, entry)| server_from_json(name, entry))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn read_tools(home: &ConfigHome) -> Vec<proto::McpToolState> {
    MCP_TOOLS.iter().map(|t| read_tool(*t, home)).collect()
}

pub fn read_source(state_dir: &Path) -> Result<Vec<proto::McpServer>> {
    let path = source_path(state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| format!("{} is not valid JSON", path.display()))?;
    let mut servers = servers_from_json_root(&root);
    if let Some(map) = root.get("mcpServers").and_then(|v| v.as_object()) {
        for server in &mut servers {
            server.destinations =
                destinations_from_json(map.get(&server.name).and_then(|e| e.get("destinations")));
        }
    }
    Ok(servers)
}

pub fn write_source(state_dir: &Path, servers: &[proto::McpServer]) -> Result<PathBuf> {
    let path = source_path(state_dir);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut map = serde_json::Map::new();
    for server in servers {
        let mut entry = server_to_json(server);
        if !server.destinations.is_empty() {
            let destinations: Vec<serde_json::Value> = server
                .destinations
                .iter()
                .map(|d| serde_json::to_value(d).expect("AgentKind always serializes"))
                .collect();
            if let serde_json::Value::Object(ref mut obj) = entry {
                obj.insert(
                    "destinations".to_string(),
                    serde_json::Value::Array(destinations),
                );
            }
        }
        map.insert(server.name.clone(), entry);
    }
    let root = serde_json::json!({ "mcpServers": serde_json::Value::Object(map) });
    let mut text = serde_json::to_string_pretty(&root)?;
    text.push('\n');
    std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    Ok(path)
}

fn pairs_to_json(pairs: &[(String, String)]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (k, v) in pairs {
        map.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    serde_json::Value::Object(map)
}

pub fn server_to_json(server: &proto::McpServer) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    match server.transport {
        proto::McpTransport::Stdio => {
            if let Some(command) = &server.command {
                obj.insert(
                    "command".to_string(),
                    serde_json::Value::String(command.clone()),
                );
            }
            if !server.args.is_empty() {
                obj.insert(
                    "args".to_string(),
                    serde_json::Value::Array(
                        server
                            .args
                            .iter()
                            .map(|a| serde_json::Value::String(a.clone()))
                            .collect(),
                    ),
                );
            }
        }
        proto::McpTransport::Http | proto::McpTransport::Sse => {
            obj.insert(
                "type".to_string(),
                serde_json::Value::String(
                    match server.transport {
                        proto::McpTransport::Sse => "sse",
                        _ => "http",
                    }
                    .to_string(),
                ),
            );
            if let Some(url) = &server.url {
                obj.insert("url".to_string(), serde_json::Value::String(url.clone()));
            }
            if !server.headers.is_empty() {
                obj.insert("headers".to_string(), pairs_to_json(&server.headers));
            }
        }
    }
    if !server.env.is_empty() {
        obj.insert("env".to_string(), pairs_to_json(&server.env));
    }
    if let Some(cwd) = &server.cwd {
        obj.insert("cwd".to_string(), serde_json::Value::String(cwd.clone()));
    }
    if !server.enabled {
        obj.insert("enabled".to_string(), serde_json::Value::Bool(false));
    }
    serde_json::Value::Object(obj)
}

pub fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let is_reference = value.starts_with('$')
        && value
            .trim_start_matches(['$', '{'])
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    if is_reference {
        return value.to_string();
    }
    if value.chars().count() <= 6 {
        return "••••".to_string();
    }
    let head: String = value.chars().take(3).collect();
    format!("{head}••••")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(dir: &tempfile::TempDir) -> ConfigHome {
        ConfigHome {
            home: dir.path().to_path_buf(),
            xdg_config: Some(dir.path().join("xdg")),
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    }

    fn stdio(name: &str, command: &str, args: &[&str]) -> proto::McpServer {
        finish(proto::McpServer {
            command: Some(command.to_string()),
            args: args.iter().map(|a| a.to_string()).collect(),
            ..empty_server(name)
        })
    }

    #[test]
    fn an_mcp_remote_wrapper_and_a_plain_http_entry_are_the_same_server() {
        let wrapped = stdio(
            "docs",
            "npx",
            &[
                "-y",
                "mcp-remote",
                "https://example.test/mcp",
                "--header",
                "X-Key: 1",
            ],
        );
        let direct = finish(proto::McpServer {
            transport: proto::McpTransport::Http,
            url: Some("https://example.test/mcp".to_string()),
            headers: vec![("X-Key".to_string(), "1".to_string())],
            ..empty_server("docs")
        });
        assert_eq!(
            wrapped.fingerprint, direct.fingerprint,
            "{wrapped:?}\n{direct:?}"
        );

        let pinned = stdio(
            "docs",
            "bunx",
            &[
                "-y",
                "mcp-remote@0.1.2",
                "https://example.test/mcp",
                "--header",
                "X-Key: 1",
            ],
        );
        assert_eq!(pinned.fingerprint, direct.fingerprint);

        let elsewhere = finish(proto::McpServer {
            url: Some("https://other.test/mcp".to_string()),
            ..direct.clone()
        });
        assert_ne!(elsewhere.fingerprint, direct.fingerprint);
        let off = finish(proto::McpServer {
            enabled: false,
            ..direct.clone()
        });
        assert_ne!(off.fingerprint, direct.fingerprint);
    }

    #[test]
    fn an_ordinary_local_command_is_not_mistaken_for_a_wrapper() {
        let plain = stdio("tool", "npx", &["-y", "@upstash/context7-mcp"]);
        assert!(
            plain.fingerprint.starts_with("stdio|"),
            "{}",
            plain.fingerprint
        );
        let elsewhere = finish(proto::McpServer {
            cwd: Some("/tmp/elsewhere".to_string()),
            ..stdio("tool", "npx", &["-y", "@upstash/context7-mcp"])
        });
        assert_ne!(plain.fingerprint, elsewhere.fingerprint);
    }

    #[test]
    fn each_tools_own_spelling_reads_into_the_same_shape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        write(
            &tool_config_path(proto::AgentKind::Codex, &h).expect("codex path"),
            "model = \"gpt-5\"\n\n[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\n",
        );
        write(
            &tool_config_path(proto::AgentKind::Cursor, &h).expect("cursor path"),
            "{\"mcpServers\":{\"context7\":{\"command\":\"npx\",\"args\":[\"-y\",\"@upstash/context7-mcp\"]}}}",
        );
        write(
            &tool_config_path(proto::AgentKind::Opencode, &h).expect("opencode path"),
            "{\"mcp\":{\"context7\":{\"type\":\"local\",\"command\":[\"npx\",\"-y\",\"@upstash/context7-mcp\"]}}}",
        );

        let cols = read_tools(&h);
        let print_for = |tool: proto::AgentKind| -> String {
            let col = cols
                .iter()
                .find(|c| c.tool == tool)
                .unwrap_or_else(|| panic!("no column for {tool:?}"));
            assert!(col.detected, "{col:?}");
            assert!(col.error.is_none(), "{col:?}");
            assert_eq!(col.servers.len(), 1, "{col:?}");
            col.servers[0].fingerprint.clone()
        };
        let codex = print_for(proto::AgentKind::Codex);
        let cursor = print_for(proto::AgentKind::Cursor);
        let opencode = print_for(proto::AgentKind::Opencode);
        assert_eq!(
            codex, cursor,
            "Codex's TOML and Cursor's JSON describe the same server"
        );
        assert_eq!(
            cursor, opencode,
            "OpenCode's single-array command is the same server too"
        );
    }

    #[test]
    fn the_claude_reader_takes_mcp_servers_and_leaves_the_rest_of_that_file_alone() {
        let text = r#"{
          "oauthAccount": {"emailAddress": "dev@example.test"},
          "mcpServers": {"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}},
          "projects": {"/home/dev/p": {"mcpServers": {"secret-project-server": {"command": "nope"}}}}
        }"#;
        let servers = read_claude_servers(text).expect("parse");
        assert_eq!(servers.len(), 1, "{servers:?}");
        assert_eq!(servers[0].name, "context7");
        assert!(
            !servers.iter().any(|s| s.name == "secret-project-server"),
            "a per-project entry is outside the carve-out and must not be read"
        );

        assert!(read_claude_servers(r#"{"oauthAccount":{}}"#)
            .expect("no key")
            .is_empty());
        assert!(read_claude_servers("").expect("empty").is_empty());
        assert!(read_claude_servers("{ not json").is_err());
    }

    #[test]
    fn the_claude_column_reads_that_file_and_the_matrix_has_four_columns() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        write(
            &tool_config_path(proto::AgentKind::Claude, &h).expect("claude path"),
            "{\"mcpServers\":{\"context7\":{\"command\":\"npx\",\"args\":[\"-y\",\"@upstash/context7-mcp\"]}}}",
        );
        let cols = read_tools(&h);
        assert_eq!(cols.len(), 4, "Houston's four tools, Claude first");
        assert_eq!(cols[0].tool, proto::AgentKind::Claude);
        assert!(cols[0].detected);
        assert_eq!(cols[0].servers.len(), 1);
        write(
            &tool_config_path(proto::AgentKind::Claude, &h).expect("claude path"),
            "{ truncated",
        );
        let cols = read_tools(&h);
        assert!(cols[0].error.is_some(), "{:?}", cols[0]);
        assert!(cols[1..].iter().all(|c| c.error.is_none()), "{cols:?}");
    }

    #[test]
    fn houstons_own_entry_is_not_one_of_the_tools_servers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        write(
            &tool_config_path(proto::AgentKind::Cursor, &h).expect("cursor path"),
            "{\"mcpServers\":{\"houston\":{\"url\":\"${env:HOUSTON_MCP_URL}\"},\
             \"docs\":{\"command\":\"npx\",\"args\":[\"docs-mcp\"]}}}",
        );
        let col = read_tool(proto::AgentKind::Cursor, &h);
        assert!(col.error.is_none(), "{col:?}");
        assert_eq!(
            col.servers
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["docs"],
            "Houston's own entry must not appear as one of Cursor's servers: {col:?}"
        );
    }

    #[test]
    fn opencode_is_found_under_either_spelling_and_comments_do_not_break_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let jsonc = h.config_dir().join("opencode").join("opencode.jsonc");
        write(
            &jsonc,
            "{\n  // my note, and a URL that must not be mistaken for one\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"mcp\": {\"docs\": {\"type\": \"local\", \"command\": [\"npx\", \"docs-mcp\"]}}\n}\n",
        );
        let col = read_tool(proto::AgentKind::Opencode, &h);
        assert!(col.detected, "{col:?}");
        assert!(col.error.is_none(), "{col:?}");
        assert_eq!(col.servers.len(), 1, "{col:?}");
        assert_eq!(col.servers[0].name, "docs");

        let plain = h.config_dir().join("opencode").join("opencode.json");
        write(&plain, "{\"mcp\":{\"other\":{\"command\":\"x\"}}}");
        let col = read_tool(proto::AgentKind::Opencode, &h);
        assert_eq!(col.servers[0].name, "other", "{col:?}");
    }

    #[test]
    fn a_url_inside_a_string_is_never_read_as_a_comment() {
        let text = "{\"url\": \"https://example.test/mcp\"} // trailing";
        let stripped = strip_jsonc_comments(text);
        assert!(stripped.contains("https://example.test/mcp"), "{stripped}");
        assert!(!stripped.contains("trailing"), "{stripped}");
    }

    #[test]
    fn a_missing_file_is_a_state_and_a_broken_one_is_reported_not_repaired() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        for col in read_tools(&h) {
            assert!(!col.detected, "{col:?}");
            assert!(col.error.is_none(), "{col:?}");
            assert!(
                !col.path.is_empty(),
                "a column names its file even when absent"
            );
        }

        let cursor = tool_config_path(proto::AgentKind::Cursor, &h).expect("path");
        write(&cursor, "{ not json at all ");
        let col = read_tool(proto::AgentKind::Cursor, &h);
        assert!(col.detected);
        assert!(col.error.is_some(), "{col:?}");
        assert!(col.servers.is_empty());
        assert_eq!(
            std::fs::read_to_string(&cursor).expect("read"),
            "{ not json at all ",
            "reading never rewrites the file it could not parse"
        );
    }

    #[test]
    fn a_switched_off_server_reads_as_off_in_both_spellings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        write(
            &tool_config_path(proto::AgentKind::Cursor, &h).expect("path"),
            "{\"mcpServers\":{\"a\":{\"command\":\"x\",\"disabled\":true},\"b\":{\"command\":\"y\",\"enabled\":false},\"c\":{\"command\":\"z\"}}}",
        );
        let col = read_tool(proto::AgentKind::Cursor, &h);
        let by_name: Vec<(String, bool)> = col
            .servers
            .iter()
            .map(|s| (s.name.clone(), s.enabled))
            .collect();
        assert_eq!(
            by_name,
            vec![
                ("a".to_string(), false),
                ("b".to_string(), false),
                ("c".to_string(), true)
            ]
        );
    }

    #[test]
    fn the_source_file_round_trips_through_tr_state_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = dir.path();
        assert!(read_source(state).expect("empty read").is_empty());

        let servers = vec![
            stdio("context7", "npx", &["-y", "@upstash/context7-mcp"]),
            finish(proto::McpServer {
                transport: proto::McpTransport::Http,
                url: Some("https://example.test/mcp".to_string()),
                headers: vec![("X-Key".to_string(), "1".to_string())],
                enabled: false,
                ..empty_server("remote")
            }),
        ];
        let path = write_source(state, &servers).expect("write");
        assert!(path.starts_with(state.join("mcp")));
        let back = read_source(state).expect("read");
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].fingerprint, servers[0].fingerprint);
        assert_eq!(
            back[1].fingerprint, servers[1].fingerprint,
            "a disabled http server survives the round trip, off and all"
        );
    }

    #[test]
    fn destinations_round_trip_through_the_source_file_but_never_leak_into_a_tool_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = dir.path();
        let scoped = finish(proto::McpServer {
            destinations: vec![proto::AgentKind::Claude, proto::AgentKind::Cursor],
            ..stdio("scoped", "npx", &["-y", "@upstash/context7-mcp"])
        });
        let everywhere = stdio("everywhere", "npx", &["-y", "other-mcp"]);
        write_source(state, &[scoped.clone(), everywhere.clone()]).expect("write");

        let back = read_source(state).expect("read");
        let scoped_back = back.iter().find(|s| s.name == "scoped").expect("scoped");
        assert_eq!(
            scoped_back.destinations,
            vec![proto::AgentKind::Claude, proto::AgentKind::Cursor]
        );
        let everywhere_back = back
            .iter()
            .find(|s| s.name == "everywhere")
            .expect("everywhere");
        assert!(
            everywhere_back.destinations.is_empty(),
            "empty stays empty, meaning every tool"
        );

        let entry = server_to_json(&scoped);
        assert!(
            entry.get("destinations").is_none(),
            "{entry}: destinations must not be written into a TOOL's own config"
        );
    }

    const SENT: &str = "--houston-managed=dev";

    #[test]
    fn syncing_a_json_tool_adds_ours_keeps_theirs_and_takes_back_only_ours() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = tool_config_path(proto::AgentKind::Cursor, &h).expect("path");
        write(
            &path,
            "{\"mcpServers\":{\"theirs\":{\"command\":\"their-server\"}},\"otherSetting\":true}",
        );

        let servers = vec![stdio("context7", "npx", &["-y", "@upstash/context7-mcp"])];
        let out = sync_tool(proto::AgentKind::Cursor, &h, &servers, &[], SENT).expect("sync");
        assert_eq!((out.written, out.removed), (1, 0));
        assert!(out.skipped.is_empty(), "{out:?}");

        let col = read_tool(proto::AgentKind::Cursor, &h);
        let names: Vec<&str> = col.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["context7", "theirs"]);
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(root["otherSetting"], serde_json::json!(true));

        let out = sync_tool(
            proto::AgentKind::Cursor,
            &h,
            &[],
            &["context7".to_string()],
            SENT,
        )
        .expect("unsync");
        assert_eq!((out.written, out.removed), (0, 1));
        let col = read_tool(proto::AgentKind::Cursor, &h);
        let names: Vec<&str> = col.servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["theirs"],
            "their server is not Houston's to remove"
        );
    }

    #[test]
    fn a_name_the_user_already_configured_is_skipped_with_its_reason() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = tool_config_path(proto::AgentKind::Cursor, &h).expect("path");
        write(
            &path,
            "{\"mcpServers\":{\"context7\":{\"command\":\"theirs\"}}}",
        );

        let servers = vec![stdio("context7", "npx", &["-y", "@upstash/context7-mcp"])];
        let out = sync_tool(proto::AgentKind::Cursor, &h, &servers, &[], SENT).expect("sync");
        assert_eq!(out.written, 0);
        assert_eq!(out.skipped.len(), 1, "{out:?}");
        assert!(out.skipped[0].contains("context7"), "{out:?}");
        let col = read_tool(proto::AgentKind::Cursor, &h);
        assert_eq!(col.servers[0].command.as_deref(), Some("theirs"));
    }

    #[test]
    fn codex_gets_a_marked_block_that_leaves_the_rest_of_the_file_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = tool_config_path(proto::AgentKind::Codex, &h).expect("path");
        let original = "# my own comment\nmodel = \"gpt-5\"\n\n[features]\nweb_search = true\n";
        write(&path, original);

        let servers = vec![stdio("context7", "npx", &["-y", "@upstash/context7-mcp"])];
        let out = sync_tool(proto::AgentKind::Codex, &h, &servers, &[], SENT).expect("sync");
        assert_eq!(out.written, 1);
        let after = std::fs::read_to_string(&path).expect("read");
        assert!(after.starts_with(original), "{after}");
        assert!(after.contains("[mcp_servers.context7]"), "{after}");
        assert!(after.contains("houston managed (mcp)"), "{after}");
        let col = read_tool(proto::AgentKind::Codex, &h);
        assert!(col.error.is_none(), "{col:?}");
        assert_eq!(col.servers.len(), 1);

        sync_tool(proto::AgentKind::Codex, &h, &servers, &[], SENT).expect("resync");
        let after = std::fs::read_to_string(&path).expect("read");
        assert_eq!(
            after.matches("[mcp_servers.context7]").count(),
            1,
            "{after}"
        );
        assert_eq!(
            after
                .lines()
                .filter(|l| l.contains("houston managed"))
                .count(),
            2,
            "exactly one block: an open marker and a close marker\n{after}"
        );

        let out = sync_tool(proto::AgentKind::Codex, &h, &[], &[], SENT).expect("unsync");
        assert_eq!(out.removed, 1);
        let after = std::fs::read_to_string(&path).expect("read");
        assert!(!after.contains("houston managed"), "{after}");
        assert!(after.starts_with(original), "{after}");
    }

    #[test]
    fn codex_refuses_to_duplicate_a_table_the_user_declared_themselves() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = tool_config_path(proto::AgentKind::Codex, &h).expect("path");
        write(&path, "[mcp_servers.context7]\ncommand = \"theirs\"\n");
        let servers = vec![stdio("context7", "npx", &["-y", "@upstash/context7-mcp"])];
        let out = sync_tool(proto::AgentKind::Codex, &h, &servers, &[], SENT).expect("sync");
        assert_eq!(out.written, 0);
        assert_eq!(out.skipped.len(), 1, "{out:?}");
        let col = read_tool(proto::AgentKind::Codex, &h);
        assert_eq!(col.servers.len(), 1);
        assert_eq!(col.servers[0].command.as_deref(), Some("theirs"));
    }

    #[test]
    fn a_secret_is_masked_but_the_name_of_one_is_not() {
        assert_eq!(mask_secret("${AI_MEMORY_TOKEN}"), "${AI_MEMORY_TOKEN}");
        assert_eq!(mask_secret("$AI_MEMORY_TOKEN"), "$AI_MEMORY_TOKEN");
        assert_eq!(mask_secret("abc"), "••••");
        assert_eq!(mask_secret("sk-live-1234567890"), "sk-••••");
        assert_eq!(mask_secret(""), "");
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncOutcome {
    pub written: usize,
    pub removed: usize,
    pub skipped: Vec<String>,
}

fn toml_block_markers(sentinel: &str) -> (String, String) {
    (
        format!("# >>> houston managed (mcp) {sentinel} >>>"),
        format!("# <<< houston managed (mcp) {sentinel} <<<"),
    )
}

/// `owned` is what Houston wrote last time, from the daemon's own record. A name
/// in the tool's config that Houston does NOT own is left exactly as it is and
/// reported in `skipped`: the user put it there, and this manages Houston's list.
pub fn sync_tool(
    tool: proto::AgentKind,
    home: &ConfigHome,
    servers: &[proto::McpServer],
    owned: &[String],
    sentinel: &str,
) -> Result<SyncOutcome> {
    let path = tool_config_path(tool, home)
        .ok_or_else(|| anyhow::anyhow!("{tool:?} has no MCP config path Houston knows about"))?;
    match tool {
        proto::AgentKind::Codex => sync_codex(&path, servers, owned, sentinel),
        proto::AgentKind::Cursor => sync_json(&path, "mcpServers", servers, owned),
        proto::AgentKind::Opencode => sync_json(&path, "mcp", servers, owned),
        other => anyhow::bail!("{other:?} is not written by this path"),
    }
}

fn sync_json(
    path: &Path,
    key: &str,
    servers: &[proto::McpServer],
    owned: &[String],
) -> Result<SyncOutcome> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let mut root: serde_json::Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).with_context(|| {
            format!(
                "{} is not valid JSON — refusing to rewrite it",
                path.display()
            )
        })?
    };
    let obj = root.as_object_mut().with_context(|| {
        format!(
            "{}: expected a JSON object at the top level",
            path.display()
        )
    })?;
    if !obj.get(key).map(|v| v.is_object()).unwrap_or(false) {
        if obj.contains_key(key) {
            anyhow::bail!("{}: \"{key}\" is not an object", path.display());
        }
        obj.insert(key.to_string(), serde_json::json!({}));
    }
    let map = obj
        .get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("just ensured");

    let mut outcome = SyncOutcome {
        written: 0,
        removed: 0,
        skipped: Vec::new(),
    };
    let wanted: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
    for name in owned {
        if !wanted.contains(&name.as_str()) && map.remove(name).is_some() {
            outcome.removed += 1;
        }
    }
    for server in servers {
        if map.contains_key(&server.name) && !owned.contains(&server.name) {
            outcome.skipped.push(format!(
                "{}: already configured here by someone other than Houston — left untouched",
                server.name
            ));
            continue;
        }
        map.insert(server.name.clone(), server_to_json(server));
        outcome.written += 1;
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(outcome)
}

/// Line-based on purpose: reserialising through a TOML parser would reformat
/// everything the user wrote and drop their comments — the silent rewrite the
/// invariant forbids even when the values survive.
fn sync_codex(
    path: &Path,
    servers: &[proto::McpServer],
    _owned: &[String],
    sentinel: &str,
) -> Result<SyncOutcome> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let (open, close) = toml_block_markers(sentinel);
    let mut lines: Vec<String> = if text.is_empty() {
        Vec::new()
    } else {
        text.lines().map(str::to_string).collect()
    };
    let existing_open = lines.iter().position(|l| l.trim() == open);
    let mut removed = 0usize;
    if let Some(start) = existing_open {
        let end = lines
            .iter()
            .skip(start)
            .position(|l| l.trim() == close)
            .map(|off| start + off)
            .with_context(|| {
                format!(
                    "{}: Houston's managed block opens at line {} and is never closed — refusing to \
                     guess where it ends",
                    path.display(),
                    start + 1
                )
            })?;
        removed = lines[start..=end]
            .iter()
            .filter(|l| l.trim_start().starts_with("[mcp_servers."))
            .count();
        lines.drain(start..=end);
    }
    let mut outcome = SyncOutcome {
        written: 0,
        removed,
        skipped: Vec::new(),
    };
    let mut block = vec![open.clone()];
    for server in servers {
        let header = format!("[mcp_servers.{}]", server.name);
        if lines.iter().any(|l| l.trim() == header) {
            outcome.skipped.push(format!(
                "{}: already declared in config.toml outside Houston's block — left untouched",
                server.name
            ));
            continue;
        }
        block.push(header);
        if let Some(command) = &server.command {
            block.push(format!("command = {}", toml_string(command)));
        }
        if !server.args.is_empty() {
            let args: Vec<String> = server.args.iter().map(|a| toml_string(a)).collect();
            block.push(format!("args = [{}]", args.join(", ")));
        }
        if let Some(url) = &server.url {
            block.push(format!("url = {}", toml_string(url)));
        }
        if !server.env.is_empty() {
            let env: Vec<String> = server
                .env
                .iter()
                .map(|(k, v)| format!("{k} = {}", toml_string(v)))
                .collect();
            block.push(format!("env = {{ {} }}", env.join(", ")));
        }
        block.push(String::new());
        outcome.written += 1;
    }
    block.push(close);

    if outcome.written > 0 || removed > 0 {
        if !lines.is_empty() && !lines.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        if outcome.written > 0 {
            lines.extend(block);
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let mut out = lines.join("\n");
        out.push('\n');
        std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(outcome)
}
