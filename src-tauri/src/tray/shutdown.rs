use crate::host::ConnectionInfo;
use crate::wsl::EnvEntry;
use futures_util::future::join_all;
use std::time::Duration;

// A shutdown includes the five-second PTY drain and a scrollback checkpoint.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) async fn stop_all(
    local: Option<ConnectionInfo>,
    environments: Vec<EnvEntry>,
) -> Vec<String> {
    stop_all_with_timeout(local, environments, SHUTDOWN_TIMEOUT).await
}

async fn stop_all_with_timeout(
    local: Option<ConnectionInfo>,
    environments: Vec<EnvEntry>,
    timeout: Duration,
) -> Vec<String> {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
    {
        Ok(client) => client,
        Err(error) => return vec![format!("could not initialize daemon shutdown: {error}")],
    };
    let mut targets = vec![("local".to_string(), local)];
    targets.extend(environments.into_iter().map(|env| {
        let connection = (env.port != 0 && !env.token.is_empty()).then_some(ConnectionInfo {
            port: env.port,
            token: env.token,
        });
        (env.id, connection)
    }));
    join_all(targets.into_iter().map(|(name, connection)| {
        let client = &client;
        async move {
            let Some(connection) = connection else {
                return Some(format!("{name}: daemon connection is unavailable"));
            };
            let answer = crate::daemon_host::manage_post(
                client,
                connection.port,
                &connection.token,
                houston_protocol::ManageVerb::DaemonShutdown,
            )
            .await;
            match answer {
                Ok((status, body)) if status.is_success() && body["ok"] == true => None,
                Ok((status, body)) => {
                    Some(format!("{name}: shutdown refused (HTTP {status}): {body}"))
                }
                Err(error) => Some(format!("{name}: {error}")),
            }
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn daemon(body: &'static str) -> (ConnectionInfo, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let len = stream.read(&mut chunk).await.unwrap();
                assert_ne!(len, 0);
                data.extend_from_slice(&chunk[..len]);
                if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|v| v.parse().unwrap())
                        })
                        .unwrap();
                    if data.len() >= end + 4 + length {
                        assert!(headers.starts_with("POST /manage HTTP/1.1"));
                        assert!(headers
                            .to_ascii_lowercase()
                            .contains("authorization: bearer fixture-token"));
                        let json: serde_json::Value =
                            serde_json::from_slice(&data[end + 4..]).unwrap();
                        assert_eq!(json["verb"], "daemon_shutdown");
                        assert_eq!(json["manage_version"], houston_protocol::MANAGE_VERSION);
                        break;
                    }
                }
            }
            stream.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        });
        (
            ConnectionInfo {
                port,
                token: "fixture-token".into(),
            },
            task,
        )
    }

    fn wsl(connection: ConnectionInfo) -> EnvEntry {
        EnvEntry {
            id: "wsl:Ubuntu".into(),
            kind: "wsl",
            distro: Some("Ubuntu".into()),
            slot: 1,
            port: connection.port,
            token: connection.token,
            state: "ready",
            reason: None,
        }
    }

    #[tokio::test]
    async fn native_shutdown_reaches_local_and_wsl_without_a_renderer() {
        let (local, local_task) = daemon(r#"{"ok":true}"#).await;
        let (remote, remote_task) = daemon(r#"{"ok":true}"#).await;
        assert!(stop_all(Some(local), vec![wsl(remote)]).await.is_empty());
        local_task.await.unwrap();
        remote_task.await.unwrap();
    }

    #[tokio::test]
    async fn a_refusal_is_visible_and_does_not_prevent_other_daemons_stopping() {
        let (local, local_task) = daemon(r#"{"ok":false,"error":"session 7 would not end"}"#).await;
        let (remote, remote_task) = daemon(r#"{"ok":true}"#).await;
        let failures = stop_all(Some(local), vec![wsl(remote)]).await;
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("local") && failures[0].contains("session 7"));
        local_task.await.unwrap();
        remote_task.await.unwrap();
    }

    #[tokio::test]
    async fn an_unavailable_local_connection_does_not_wait_for_renderer_boot() {
        let (remote, task) = daemon(r#"{"ok":true}"#).await;
        let failures = stop_all(None, vec![wsl(remote)]).await;
        assert_eq!(failures, ["local: daemon connection is unavailable"]);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn a_wedged_daemon_is_bounded_and_other_environments_still_stop() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = ConnectionInfo {
            port: listener.local_addr().unwrap().port(),
            token: "fixture-token".into(),
        };
        let (remote, task) = daemon(r#"{"ok":true}"#).await;
        let failures = tokio::time::timeout(
            Duration::from_secs(5),
            stop_all_with_timeout(Some(local), vec![wsl(remote)], Duration::from_millis(100)),
        )
        .await
        .expect("shutdown must not hang with an unresponsive daemon");
        assert_eq!(failures.len(), 1);
        assert!(failures[0].starts_with("local:"));
        task.await.unwrap();
    }
}
