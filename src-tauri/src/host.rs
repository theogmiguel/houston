use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Clone)]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Clone)]
pub struct ConnectionCell {
    boot: tokio::sync::watch::Receiver<Option<ConnectionInfo>>,
    state_dir: PathBuf,
    discovered: Arc<Mutex<Option<Option<ConnectionInfo>>>>,
    refresh: Arc<tokio::sync::Mutex<()>>,
}

impl ConnectionCell {
    pub fn new(
        rx: tokio::sync::watch::Receiver<Option<ConnectionInfo>>,
        state_dir: PathBuf,
    ) -> Self {
        Self {
            boot: rx,
            state_dir,
            discovered: Arc::new(Mutex::new(None)),
            refresh: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn current(&self) -> Option<ConnectionInfo> {
        self.discovered
            .lock()
            .expect("connection cache lock")
            .clone()
            .unwrap_or_else(|| self.boot.borrow().clone())
    }

    pub async fn get(&self) -> Result<ConnectionInfo, String> {
        let _refresh = self.refresh.lock().await;
        let mut rx = self.boot.clone();
        loop {
            if rx.borrow().is_some() {
                break;
            }
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
        let result = crate::daemon_host::discover_running_daemon(&self.state_dir)
            .await
            .map(|handle| ConnectionInfo {
                port: handle.port,
                token: handle.token,
            });
        // A failed refresh must not expose the old boot endpoint to local users.
        *self.discovered.lock().expect("connection cache lock") =
            Some(result.as_ref().ok().cloned());
        result
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub async fn host_config(connection: State<'_, ConnectionCell>) -> Result<HostConfig, String> {
    let info = connection.get().await?;
    Ok(HostConfig {
        port: info.port,
        token: info.token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_config_serializes_the_expected_key_set() {
        let cfg = HostConfig {
            port: 4321,
            token: "test-token-0000-0000-000000000000".to_string(),
        };
        let value = serde_json::to_value(&cfg).unwrap();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["port", "token"],
            "wire key set must match houston/host.ts's HostConfig interface \
             (port/token), got: {value}"
        );
    }

    #[test]
    fn host_config_source_has_no_logging_call() {
        let src = include_str!("host.rs");
        let before_this_test = src
            .split("fn host_config_source_has_no_logging_call")
            .next()
            .unwrap();
        for needle in ["eprintln!", "println!", "tracing::"] {
            assert!(
                !before_this_test.contains(needle),
                "host.rs must not log at all (the token is a secret in scope here); found {needle:?}"
            );
        }
    }

    fn status() -> serde_json::Value {
        serde_json::json!({
            "manage_version": houston_protocol::MANAGE_VERSION,
            "protocol_version": houston_protocol::PROTOCOL_VERSION,
            "build": houston_core::daemon::build_commit(),
            "pid": std::process::id(), "started_at": "2026-01-01T00:00:00Z",
            "live_sessions": { "count": 0, "ids": [] },
            "routines_enabled": 0, "clients_connected": 0,
            "handoff": { "supported": false, "reason": "" },
            "reap": { "armed": false, "deadline_ms": null }
        })
    }

    fn discovery(port: u16, token: &str) -> serde_json::Value {
        serde_json::json!({ "pid": std::process::id(), "port": port, "token": token })
    }

    fn cell(dir: &std::path::Path, port: u16, token: &str) -> ConnectionCell {
        let (_tx, rx) = tokio::sync::watch::channel(Some(ConnectionInfo {
            port,
            token: token.into(),
        }));
        ConnectionCell::new(rx, dir.to_path_buf())
    }

    async fn fake_manage(
        dir: &std::path::Path,
        token: &str,
        body: String,
        status_line: &str,
        replace_discovery: bool,
        chunked: bool,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let path = dir.join("daemon.json");
        std::fs::write(&path, discovery(port, token).to_string()).unwrap();
        let token = token.to_string();
        let status_line = status_line.to_string();
        let worker = tokio::spawn(async move {
            let (mut socket, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut request = Vec::new();
            loop {
                let mut bytes = [0; 4096];
                let count = socket.read(&mut bytes).await.unwrap();
                assert!(count > 0, "probe closed before its request was complete");
                request.extend_from_slice(&bytes[..count]);
                assert!(
                    request.len() < 16 * 1024,
                    "probe request exceeded fixture limit"
                );
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let header = &text[..end];
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|length| length.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        assert!(header.starts_with("POST /manage HTTP/1.1"));
                        assert!(header.lines().any(|line| line
                            .eq_ignore_ascii_case(&format!("authorization: Bearer {token}"))));
                        let body: serde_json::Value =
                            serde_json::from_slice(&request[end + 4..]).unwrap();
                        assert_eq!(
                            body["verb"], "daemon_status",
                            "reconnect must never request handoff or shutdown"
                        );
                        assert_eq!(body["manage_version"], houston_protocol::MANAGE_VERSION);
                        break;
                    }
                }
            }
            if replace_discovery {
                std::fs::write(path, discovery(port, "successor-token").to_string()).unwrap();
            }
            let response = if chunked {
                format!("HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len())
            } else {
                format!("HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
            };
            // Refusals may stop reading a bounded response before the fixture finishes.
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
        (port, worker)
    }

    async fn finish(worker: tokio::task::JoinHandle<()>) {
        tokio::time::timeout(std::time::Duration::from_secs(5), worker)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn reconnect_discovers_a_new_port_and_token_in_the_same_app_cell() {
        let dir = tempfile::tempdir().unwrap();
        let (first_port, first) = fake_manage(
            dir.path(),
            "first-token",
            status().to_string(),
            "200 OK",
            false,
            false,
        )
        .await;
        let connection = cell(dir.path(), first_port, "first-token");
        assert_eq!(connection.get().await.unwrap().port, first_port);
        let (second_port, second) = fake_manage(
            dir.path(),
            "second-token",
            status().to_string(),
            "200 OK",
            false,
            false,
        )
        .await;
        let refreshed = connection.get().await.unwrap();
        assert_eq!(refreshed.port, second_port);
        assert_eq!(refreshed.token, "second-token");
        assert_eq!(connection.clone().current().unwrap().token, "second-token");
        finish(first).await;
        finish(second).await;
    }

    #[tokio::test]
    async fn boot_accepted_same_wire_daemon_from_another_build_remains_connectable() {
        let dir = tempfile::tempdir().unwrap();
        let mut accepted = status();
        accepted["build"] = "accepted-other-build".into();
        assert_ne!(accepted["build"], houston_core::daemon::build_commit());
        let (port, server) = fake_manage(
            dir.path(),
            "accepted-boot-token",
            accepted.to_string(),
            "200 OK",
            false,
            false,
        )
        .await;
        let connection = cell(dir.path(), port, "accepted-boot-token");
        assert_eq!(connection.current().unwrap().port, port);
        let configured = connection.get().await.unwrap();
        assert_eq!(configured.port, port);
        assert_eq!(configured.token, "accepted-boot-token");
        finish(server).await;
    }

    #[tokio::test]
    async fn missing_or_invalid_discovery_never_reuses_boot_credentials_or_spawns() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("stopped-channel");
        let connection = cell(&missing, 1234, "boot-token-secret");
        assert!(connection.get().await.is_err());
        assert!(connection.current().is_none());
        assert!(
            !missing.exists(),
            "reconnect must not create a stopped daemon's state directory"
        );
        for bytes in [
            b"{\"token\":\"malformed-token-secret\",".to_vec(),
            vec![b' '; 16 * 1024 + 1],
            serde_json::json!({"pid": 0, "port": 1234, "token": "invalid-token-secret"})
                .to_string()
                .into_bytes(),
            serde_json::json!({"pid": u32::MAX, "port": 1234, "token": "invalid-token-secret"})
                .to_string()
                .into_bytes(),
        ] {
            let path = dir.path().join("daemon.json");
            std::fs::write(&path, &bytes).unwrap();
            let connection = cell(dir.path(), 1234, "boot-token-secret");
            let error = connection.get().await.err().unwrap();
            assert!(
                !error.contains("token-secret"),
                "discovery parse errors must not expose credentials"
            );
            assert!(connection.current().is_none());
            assert_eq!(
                std::fs::read(path).unwrap(),
                bytes,
                "reconnect is read-only"
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        std::fs::create_dir(&missing).unwrap();
        let (port, server) = fake_manage(
            &missing,
            "explicit-restart-token",
            status().to_string(),
            "200 OK",
            false,
            false,
        )
        .await;
        let recovered = connection.get().await.unwrap();
        assert_eq!(recovered.port, port);
        assert_eq!(recovered.token, "explicit-restart-token");
        finish(server).await;
    }

    #[tokio::test]
    async fn stale_discovery_and_failed_identity_probes_do_not_publish_a_connection() {
        let dir = tempfile::tempdir().unwrap();
        let stale =
            serde_json::json!({ "pid": i32::MAX, "port": 1234, "token": "stale-token-secret" });
        std::fs::write(dir.path().join("daemon.json"), stale.to_string()).unwrap();
        let connection = cell(dir.path(), 1234, "boot-token-secret");
        assert!(connection
            .get()
            .await
            .err()
            .unwrap()
            .contains("stopped process"));
        assert!(connection.current().is_none());
        let mut responses = Vec::new();
        let mut wrong_wire = status();
        wrong_wire["protocol_version"] = serde_json::json!(houston_protocol::PROTOCOL_VERSION + 1);
        responses.push((wrong_wire.to_string(), "200 OK"));
        let mut wrong_pid = status();
        wrong_pid["pid"] = 0.into();
        responses.push((wrong_pid.to_string(), "200 OK"));
        let mut wrong_manage = status();
        wrong_manage["manage_version"] = (houston_protocol::MANAGE_VERSION + 1).into();
        responses.push((wrong_manage.to_string(), "200 OK"));
        responses.push((
            "{\"error\":\"response-token-secret\"}".into(),
            "401 Unauthorized",
        ));
        responses.push(("invalid response-token-secret".into(), "200 OK"));
        for (body, status_line) in responses {
            let (port, server) = fake_manage(
                dir.path(),
                "probe-token-secret",
                body,
                status_line,
                false,
                false,
            )
            .await;
            let connection = cell(dir.path(), port, "boot-token-secret");
            let error = connection.get().await.err().unwrap();
            assert!(
                !error.contains("token-secret"),
                "HTTP and status errors must not expose credentials"
            );
            assert!(connection.current().is_none());
            finish(server).await;
        }
    }

    #[tokio::test]
    async fn reconnect_refuses_a_discovery_generation_changed_during_its_probe() {
        let dir = tempfile::tempdir().unwrap();
        let (port, server) = fake_manage(
            dir.path(),
            "first-token",
            status().to_string(),
            "200 OK",
            true,
            false,
        )
        .await;
        let connection = cell(dir.path(), port, "first-token");
        assert!(connection
            .get()
            .await
            .err()
            .unwrap()
            .contains("changed during reconnect"));
        assert!(connection.current().is_none());
        finish(server).await;
    }

    #[tokio::test]
    async fn reconnect_status_reads_are_bounded_with_or_without_content_length() {
        let dir = tempfile::tempdir().unwrap();
        for chunked in [false, true] {
            let (port, server) = fake_manage(
                dir.path(),
                "bounded-token",
                " ".repeat(64 * 1024 + 1),
                "200 OK",
                false,
                chunked,
            )
            .await;
            let connection = cell(dir.path(), port, "boot-token-secret");
            assert!(connection.get().await.err().unwrap().contains("read limit"));
            assert!(connection.current().is_none());
            finish(server).await;
        }
    }

    #[tokio::test]
    async fn a_stalled_reconnect_probe_times_out_without_reusing_boot_credentials() {
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            dir.path().join("daemon.json"),
            discovery(port, "stalled-token").to_string(),
        )
        .unwrap();
        let (release, released) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            let _ = released.await;
        });
        let connection = cell(dir.path(), port, "boot-token-secret");
        let error = tokio::time::timeout(std::time::Duration::from_secs(4), connection.get())
            .await
            .unwrap()
            .err()
            .unwrap();
        assert!(
            error.contains("probe"),
            "the stalled request must produce a bounded probe error"
        );
        assert!(connection.current().is_none());
        release.send(()).unwrap();
        finish(server).await;
    }
}
