use tauri::State;

#[derive(Clone)]
pub struct ConnectionInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Clone)]
pub struct ConnectionCell(tokio::sync::watch::Receiver<Option<ConnectionInfo>>);

impl ConnectionCell {
    pub fn new(rx: tokio::sync::watch::Receiver<Option<ConnectionInfo>>) -> Self {
        Self(rx)
    }

    pub async fn get(&self) -> ConnectionInfo {
        let mut rx = self.0.clone();
        loop {
            if let Some(info) = rx.borrow().clone() {
                return info;
            }
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub port: u16,
    pub token: String,
}

#[tauri::command]
pub async fn host_config(connection: State<'_, ConnectionCell>) -> Result<HostConfig, ()> {
    let info = connection.get().await;
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
}
