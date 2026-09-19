use houston_protocol as proto;
use std::time::Duration;

// generous enough for a cold server process to start and answer once, short enough
// that a hung server doesn't hang the check itself
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

// the oldest revision Houston's own /mcp still accepts (see SUPPORTED_PROTOCOLS in
// mcp_server.rs) — probing with the floor is the most conservative test of whether a
// server speaks MCP at all
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

pub async fn test(server: &proto::McpServer) -> proto::McpConnectionCheck {
    match tokio::time::timeout(TEST_TIMEOUT, run(server)).await {
        Ok(Ok(tool_count)) => proto::McpConnectionCheck::Verified { tool_count },
        Ok(Err(message)) => proto::McpConnectionCheck::Failed { message },
        Err(_) => proto::McpConnectionCheck::Failed {
            message: format!(
                "no response within {}s — the server may be slow to start, unreachable, or hung",
                TEST_TIMEOUT.as_secs()
            ),
        },
    }
}

async fn run(server: &proto::McpServer) -> Result<u32, String> {
    match server.transport {
        proto::McpTransport::Stdio => test_stdio(server).await,
        proto::McpTransport::Http => test_http(server).await,
        proto::McpTransport::Sse => Err(
            "the legacy HTTP+SSE transport is not implemented by this probe — if this server is \
             actually Streamable HTTP (true for most servers advertising \"sse\" today), change \
             its transport to Http; a genuine legacy-SSE server cannot be tested yet"
                .to_string(),
        ),
    }
}

fn init_request() -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "houston", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

fn initialized_notification() -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

fn tools_list_request() -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })
}

fn check_no_error(v: &serde_json::Value) -> Result<(), String> {
    match v.get("error") {
        Some(err) => Err(format!("the server reported an error: {err}")),
        None => Ok(()),
    }
}

fn validate_initialize_reply(v: &serde_json::Value) -> Result<(), String> {
    let result = v
        .get("result")
        .ok_or_else(|| format!("the initialize reply had no \"result\" (got {v})"))?;
    match result.get("protocolVersion").and_then(|v| v.as_str()) {
        Some(actual) if actual == MCP_PROTOCOL_VERSION => Ok(()),
        Some(actual) => Err(format!(
            "the server answered with protocol version {actual:?}, expected {MCP_PROTOCOL_VERSION:?} \
             — this probe does not negotiate a different version"
        )),
        None => Err(format!(
            "the initialize reply had no \"result.protocolVersion\" string (got {result})"
        )),
    }
}

fn count_tools(response: &serde_json::Value) -> Result<u32, String> {
    response
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .map(|a| a.len() as u32)
        .ok_or_else(|| {
            format!("the tools/list reply had no \"result.tools\" array (got {response})")
        })
}

async fn test_stdio(server: &proto::McpServer) -> Result<u32, String> {
    let command = server
        .command
        .as_deref()
        .ok_or_else(|| "no command to run — this server has no command configured".to_string())?;
    let mut cmd = crate::spawn::tokio_command(command);
    cmd.args(&server.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for (k, v) in &server.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &server.cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawning `{command}`: {e}"))?;
    let result = speak_stdio(&mut child).await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    result
}

async fn speak_stdio(child: &mut tokio::process::Child) -> Result<u32, String> {
    use tokio::io::BufReader;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "no stdin on the spawned process".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout on the spawned process".to_string())?;
    let mut reader = BufReader::new(stdout);

    write_line(&mut stdin, &init_request()).await?;
    let init_reply = read_reply(&mut reader, 1).await?;
    check_no_error(&init_reply)?;
    validate_initialize_reply(&init_reply)?;

    write_line(&mut stdin, &initialized_notification()).await?;

    write_line(&mut stdin, &tools_list_request()).await?;
    let list_reply = read_reply(&mut reader, 2).await?;
    check_no_error(&list_reply)?;
    count_tools(&list_reply)
}

async fn write_line(
    stdin: &mut tokio::process::ChildStdin,
    value: &serde_json::Value,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("writing to the server's stdin: {e}"))
}

async fn read_reply(
    reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
    id: u64,
) -> Result<serde_json::Value, String> {
    loop {
        let line = read_bounded_line(reader)
            .await?
            .ok_or_else(|| "the server closed stdout before answering".to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| {
            format!(
                "the server's reply was not valid JSON: {e} ({})",
                safe_preview(trimmed)
            )
        })?;
        if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
            return Ok(value);
        }
    }
}

async fn read_bounded_line(
    reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
) -> Result<Option<String>, String> {
    use tokio::io::AsyncBufReadExt;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|e| format!("reading the server's stdout: {e}"))?;
        if available.is_empty() {
            return Ok((!buf.is_empty()).then(|| String::from_utf8_lossy(&buf).into_owned()));
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            buf.extend_from_slice(&available[..pos]);
            reader.consume(pos + 1);
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        let consumed = available.len();
        buf.extend_from_slice(available);
        reader.consume(consumed);
        if buf.len() > MAX_BODY_BYTES {
            return Err(format!(
                "a line from the server's stdout exceeded {MAX_BODY_BYTES} bytes without a \
                 newline — refusing to buffer more"
            ));
        }
    }
}

async fn test_http(server: &proto::McpServer) -> Result<u32, String> {
    let url = server
        .url
        .as_deref()
        .ok_or_else(|| "no URL to test — this server has no URL configured".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("building the HTTP client: {e}"))?;

    let (init_reply, session) =
        mcp_post(&client, url, &server.headers, None, &init_request()).await?;
    check_no_error(&init_reply)?;
    validate_initialize_reply(&init_reply)?;

    let _ = mcp_post(
        &client,
        url,
        &server.headers,
        session.as_deref(),
        &initialized_notification(),
    )
    .await;

    let (list_reply, _) = mcp_post(
        &client,
        url,
        &server.headers,
        session.as_deref(),
        &tools_list_request(),
    )
    .await?;
    check_no_error(&list_reply)?;
    count_tools(&list_reply)
}

async fn mcp_post(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    session: Option<&str>,
    body: &serde_json::Value,
) -> Result<(serde_json::Value, Option<String>), String> {
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .json(body);
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(id) = session {
        req = req.header("mcp-session-id", id);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("reaching {url}: {e}"))?;
    let status = resp.status();
    let session_id = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| session.map(str::to_string));
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let is_event_stream = content_type.contains("text/event-stream");
    let text = read_bounded_body(resp, is_event_stream).await?;
    if !status.is_success() {
        return Err(if status.as_u16() == 401 || status.as_u16() == 403 {
            format!("{url} answered {status} — check the configured credentials")
        } else {
            format!("{url} answered {status}: {}", safe_preview(text.trim()))
        });
    }
    if text.trim().is_empty() {
        return Ok((serde_json::json!({}), session_id));
    }
    let value = if is_event_stream {
        parse_sse_json(&text)?
    } else {
        serde_json::from_str(&text).map_err(|e| {
            format!(
                "the response was not valid JSON: {e} ({})",
                safe_preview(text.trim())
            )
        })?
    };
    Ok((value, session_id))
}

// this reads a response from a server the user configured, not our own — bounds a
// malicious or broken one from streaming an unbounded reply into memory
const MAX_BODY_BYTES: usize = 1 << 20;

async fn read_bounded_body(resp: reqwest::Response, event_stream: bool) -> Result<String, String> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("reading the response body: {e}"))?;
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_BODY_BYTES {
            return Err(format!(
                "the response body exceeded {MAX_BODY_BYTES} bytes without completing — refusing \
                 to buffer more"
            ));
        }
        if event_stream && ends_one_sse_event(&buf) {
            break;
        }
    }
    String::from_utf8(buf).map_err(|e| format!("the response was not valid UTF-8: {e}"))
}

fn ends_one_sse_event(buf: &[u8]) -> bool {
    buf.windows(2).any(|w| w == b"\n\n") || buf.windows(4).any(|w| w == b"\r\n\r\n")
}

fn safe_preview(text: &str) -> String {
    const MAX_CHARS: usize = 200;
    text.chars()
        .take(MAX_CHARS)
        .map(|c| {
            if c.is_control() && c != ' ' {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

fn parse_sse_json(text: &str) -> Result<serde_json::Value, String> {
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            return serde_json::from_str(data)
                .map_err(|e| format!("the event stream's data was not valid JSON: {e}"));
        }
    }
    Err("the server's event stream carried no data".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_server(command: &str, args: &[&str]) -> proto::McpServer {
        proto::McpServer {
            name: "under-test".to_string(),
            transport: proto::McpTransport::Stdio,
            command: Some(command.to_string()),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Vec::new(),
            url: None,
            headers: Vec::new(),
            cwd: None,
            enabled: true,
            fingerprint: String::new(),
            destinations: Vec::new(),
        }
    }

    fn fake_server_script(tool_count: usize) -> String {
        let tools: Vec<String> = (0..tool_count)
            .map(|i| format!(r#"{{"name": "tool{i}", "description": "", "inputSchema": {{"type": "object"}}}}"#))
            .collect();
        format!(
            r#"
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": {{"protocolVersion": "2024-11-05", "capabilities": {{}}, "serverInfo": {{"name": "fake", "version": "0"}}}}}}))
        sys.stdout.flush()
    elif method == "tools/list":
        print(json.dumps({{"jsonrpc": "2.0", "id": mid, "result": {{"tools": [{tools}]}}}}))
        sys.stdout.flush()
"#,
            tools = tools.join(", ")
        )
    }

    fn python() -> Option<&'static str> {
        ["python3", "python"].into_iter().find(|candidate| {
            crate::spawn::command(candidate)
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success())
        })
    }

    #[tokio::test]
    async fn a_stdio_server_that_answers_is_verified_with_its_real_tool_count() {
        let Some(python) = python() else {
            eprintln!("skipping: no python3/python on this machine");
            return;
        };
        let script = fake_server_script(3);
        let server = stdio_server(python, &["-c", &script]);
        let result = test(&server).await;
        assert_eq!(
            result,
            proto::McpConnectionCheck::Verified { tool_count: 3 },
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn a_command_that_does_not_exist_fails_fast_and_names_the_command() {
        let server = stdio_server("houston-mcp-check-nonexistent-binary", &[]);
        let result = test(&server).await;
        match result {
            proto::McpConnectionCheck::Failed { message } => {
                assert!(
                    message.contains("houston-mcp-check-nonexistent-binary"),
                    "{message}"
                );
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_server_with_no_command_or_url_fails_naming_which_is_missing() {
        let mut stdio = stdio_server("irrelevant", &[]);
        stdio.command = None;
        let result = test(&stdio).await;
        assert!(
            matches!(&result, proto::McpConnectionCheck::Failed { message } if message.contains("no command"))
        );

        let http = proto::McpServer {
            transport: proto::McpTransport::Http,
            command: None,
            url: None,
            ..stdio_server("irrelevant", &[])
        };
        let result = test(&http).await;
        assert!(
            matches!(&result, proto::McpConnectionCheck::Failed { message } if message.contains("no URL"))
        );
    }

    #[tokio::test]
    async fn a_server_that_hangs_is_reported_failed_within_the_deadline_not_left_checking() {
        let Some(python) = python() else {
            eprintln!("skipping: no python3/python on this machine");
            return;
        };
        let server = stdio_server(python, &["-c", "import time; time.sleep(120)"]);
        let started = std::time::Instant::now();
        let result = test(&server).await;
        assert!(
            matches!(result, proto::McpConnectionCheck::Failed { .. }),
            "{result:?}"
        );
        assert!(
            started.elapsed() < TEST_TIMEOUT + Duration::from_secs(5),
            "probe should stop at its own deadline, took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn an_http_server_over_streamable_http_is_verified() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let app = axum::Router::new().route("/mcp", axum::routing::post(fake_mcp_http_handler));
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let server = proto::McpServer {
            transport: proto::McpTransport::Http,
            url: Some(format!("http://{addr}/mcp")),
            ..stdio_server("irrelevant", &[])
        };
        let result = test(&server).await;
        server_task.abort();
        assert_eq!(
            result,
            proto::McpConnectionCheck::Verified { tool_count: 1 },
            "{result:?}"
        );
    }

    async fn fake_mcp_http_handler(
        axum::Json(value): axum::Json<serde_json::Value>,
    ) -> axum::Json<serde_json::Value> {
        let mid = value.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let reply = match value.get("method").and_then(|m| m.as_str()) {
            Some("initialize") => serde_json::json!({
                "jsonrpc": "2.0", "id": mid,
                "result": {"protocolVersion": "2024-11-05", "capabilities": {}, "serverInfo": {"name": "fake", "version": "0"}}
            }),
            Some("tools/list") => serde_json::json!({
                "jsonrpc": "2.0", "id": mid,
                "result": {"tools": [{"name": "one", "description": "", "inputSchema": {"type": "object"}}]}
            }),
            _ => serde_json::json!({"jsonrpc": "2.0", "id": mid, "result": {}}),
        };
        axum::Json(reply)
    }

    #[test]
    fn an_sse_framed_reply_is_parsed_the_same_as_a_plain_one() {
        let sse =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let value = parse_sse_json(sse).expect("parse");
        assert_eq!(count_tools(&value).expect("count"), 0);

        assert!(parse_sse_json("event: message\n\n").is_err());
    }

    #[tokio::test]
    async fn legacy_sse_transport_is_refused_by_name_never_treated_as_http() {
        let server = proto::McpServer {
            transport: proto::McpTransport::Sse,
            url: Some("http://127.0.0.1:1".to_string()),
            ..stdio_server("irrelevant", &[])
        };
        let result = test(&server).await;
        match result {
            proto::McpConnectionCheck::Failed { message } => {
                assert!(message.contains("legacy HTTP+SSE"), "{message}");
                assert!(message.contains("not implemented"), "{message}");
            }
            other => panic!("expected an immediate, named refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_mismatched_protocol_version_in_the_initialize_reply_is_reported_not_accepted() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let app = axum::Router::new().route(
            "/mcp",
            axum::routing::post(|axum::Json(value): axum::Json<serde_json::Value>| async move {
                let mid = value.get("id").cloned().unwrap_or(serde_json::Value::Null);
                axum::Json(serde_json::json!({
                    "jsonrpc": "2.0", "id": mid,
                    "result": {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "fake", "version": "0"}}
                }))
            }),
        );
        let server_task = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });

        let server = proto::McpServer {
            transport: proto::McpTransport::Http,
            url: Some(format!("http://{addr}/mcp")),
            ..stdio_server("irrelevant", &[])
        };
        let result = test(&server).await;
        server_task.abort();
        match result {
            proto::McpConnectionCheck::Failed { message } => {
                assert!(message.contains("2025-06-18"), "{message}");
                assert!(message.contains(MCP_PROTOCOL_VERSION), "{message}");
            }
            other => panic!("expected Failed on a version mismatch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_kept_alive_sse_connection_is_answered_from_its_first_event_not_its_close() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let counter = Arc::new(AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let n = counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let body = if n == 0 {
                        "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"serverInfo\":{\"name\":\"fake\",\"version\":\"0\"}}}\n\n".to_string()
                    } else {
                        "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"one\",\"description\":\"\",\"inputSchema\":{\"type\":\"object\"}}]}}\n\n".to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    tokio::time::sleep(Duration::from_secs(30)).await;
                });
            }
        });

        let server = proto::McpServer {
            transport: proto::McpTransport::Http,
            url: Some(format!("http://{addr}/mcp")),
            ..stdio_server("irrelevant", &[])
        };
        let started = std::time::Instant::now();
        let result = test(&server).await;
        assert_eq!(
            result,
            proto::McpConnectionCheck::Verified { tool_count: 1 },
            "{result:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a probe that waited for this (never-closing) connection to end would take the \
             full {}s timeout; took {:?}",
            TEST_TIMEOUT.as_secs(),
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn an_oversized_response_body_is_refused_rather_than_buffered_without_bound() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n",
                )
                .await;
            let chunk = vec![b'a'; 65536];
            let header = format!("{:x}\r\n", chunk.len());
            for _ in 0..64 {
                if socket.write_all(header.as_bytes()).await.is_err() {
                    break;
                }
                if socket.write_all(&chunk).await.is_err() {
                    break;
                }
                if socket.write_all(b"\r\n").await.is_err() {
                    break;
                }
            }
        });

        let server = proto::McpServer {
            transport: proto::McpTransport::Http,
            url: Some(format!("http://{addr}/mcp")),
            ..stdio_server("irrelevant", &[])
        };
        let started = std::time::Instant::now();
        let result = test(&server).await;
        match result {
            proto::McpConnectionCheck::Failed { message } => {
                assert!(message.contains("exceeded"), "{message}");
            }
            other => panic!("expected Failed on an oversized body, got {other:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a bounded read should refuse well before the {}s timeout; took {:?}",
            TEST_TIMEOUT.as_secs(),
            started.elapsed()
        );
    }
}
