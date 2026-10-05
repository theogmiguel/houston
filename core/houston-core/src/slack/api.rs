//! The handful of Slack Web API methods the intake connector calls. Every call
//! carries a token, so a URL that did not come from configuration (a file
//! download link inside an event) is checked against Slack's own hosts first.

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use reqwest::Url;
use serde_json::{json, Value};
use std::time::Duration;

use crate::ssh_credentials::Secret;

pub const DEFAULT_BASE: &str = "https://slack.com/api/";

/// Tests point the connector at a fake Slack on loopback; any other override
/// is refused so a stray environment variable cannot send tokens elsewhere.
pub const BASE_ENV: &str = "HOUSTON_SLACK_API_BASE";

/// One retry after a 429; Slack's `Retry-After` for Tier 3 methods is seconds,
/// and a longer wait is better spent on the next reconnect's catch-up.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn is_loopback(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    )
}

pub fn base_from_env() -> Result<Url> {
    match std::env::var(BASE_ENV) {
        Ok(raw) if !raw.is_empty() => {
            let url =
                Url::parse(&raw).with_context(|| format!("{BASE_ENV}={raw:?} is not a URL"))?;
            if !is_loopback(&url) {
                bail!("{BASE_ENV}={raw:?} must point at 127.0.0.1 or localhost; refusing to send Slack tokens to another host");
            }
            Ok(url)
        }
        _ => Ok(Url::parse(DEFAULT_BASE).expect("default Slack API base")),
    }
}

/// A Socket Mode URL is `wss://`, or `ws://` only on loopback (the test server).
pub fn check_socket_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)
        .map_err(|_| anyhow!("apps.connections.open returned a URL that does not parse"))?;
    match url.scheme() {
        "wss" => Ok(url),
        "ws" if is_loopback(&url) => Ok(url),
        other => bail!("apps.connections.open returned a {other}:// URL; only wss:// is accepted"),
    }
}

/// The bot token is only ever sent to Slack's file host (or the loopback test
/// server), never to a URL an event happens to carry.
pub fn check_file_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| anyhow!("a Slack file URL does not parse"))?;
    let host = url.host_str().unwrap_or_default();
    let slack = url.scheme() == "https" && (host == "slack.com" || host.ends_with(".slack.com"));
    if slack || is_loopback(&url) {
        Ok(url)
    } else {
        bail!("refusing to download a Slack file from host {host:?}: only *.slack.com is trusted with the bot token")
    }
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub team_id: String,
    pub team: String,
    pub bot_user_id: String,
}

#[derive(Clone, Copy)]
enum Body<'a> {
    Form(&'a [(&'a str, &'a str)]),
    Json(&'a Value),
}

#[derive(Clone)]
pub struct Api {
    base: Url,
    http: reqwest::Client,
}

pub struct Page {
    pub messages: Vec<Value>,
    pub next_cursor: Option<String>,
}

impl Api {
    pub fn new(base: Url) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("building the Slack HTTP client")?;
        Ok(Self { base, http })
    }

    fn url(&self, method: &str) -> Url {
        self.base
            .join(method)
            .expect("Slack method names are URL-safe")
    }

    async fn call(&self, method: &str, token: &Secret, form: &[(&str, &str)]) -> Result<Value> {
        self.send(method, token, Body::Form(form)).await
    }

    async fn call_json(&self, method: &str, token: &Secret, body: &Value) -> Result<Value> {
        self.send(method, token, Body::Json(body)).await
    }

    /// Slack's `{"ok": false, "error": ...}` (HTTP 200) is an error here. Reads
    /// take query arguments; writes send JSON, as text and blocks can outgrow a URL.
    async fn send(&self, method: &str, token: &Secret, body: Body<'_>) -> Result<Value> {
        for attempt in 0..2 {
            let mut url = self.url(method);
            let mut req = match body {
                Body::Json(value) => self.http.post(url).json(value),
                Body::Form(form) => {
                    url.query_pairs_mut().extend_pairs(form);
                    self.http.post(url)
                }
            };
            req = req.bearer_auth(token.expose());
            let resp = req
                .send()
                .await
                .map_err(|e| anyhow!("Slack {method} failed: {}", e.without_url()))?;
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
                let wait = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(Duration::from_secs(1));
                if wait > RETRY_AFTER_MAX {
                    bail!(
                        "Slack {method} is rate limited for {}s, over the {}s this call waits",
                        wait.as_secs(),
                        RETRY_AFTER_MAX.as_secs()
                    );
                }
                tokio::time::sleep(wait).await;
                continue;
            }
            let status = resp.status();
            let body: Value = resp.json().await.map_err(|_| {
                anyhow!("Slack {method} returned HTTP {status} without a JSON body")
            })?;
            if body.get("ok").and_then(Value::as_bool) != Some(true) {
                let code = body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown_error");
                bail!("Slack {method} failed: {code}");
            }
            return Ok(body);
        }
        bail!("Slack {method} is still rate limited after one retry")
    }

    pub async fn auth_test(&self, bot: &Secret) -> Result<Identity> {
        let body = self.call("auth.test", bot, &[]).await?;
        let field = |k: &str| {
            body.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let identity = Identity {
            team_id: field("team_id"),
            team: field("team"),
            bot_user_id: field("user_id"),
        };
        if identity.team_id.is_empty() || identity.bot_user_id.is_empty() {
            bail!("Slack auth.test answered without a team_id or user_id; the bot token is not a bot token");
        }
        Ok(identity)
    }

    pub async fn connections_open(&self, app: &Secret) -> Result<Url> {
        let body = self.call("apps.connections.open", app, &[]).await?;
        let raw = body
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Slack apps.connections.open answered without a url"))?;
        check_socket_url(raw)
    }

    /// Posts to a channel (in a thread when `thread_ts` is given) or a DM
    /// channel. `text` is the notification fallback when `blocks` is given.
    /// Returns the posted message's `ts`.
    pub async fn post_message(
        &self,
        bot: &Secret,
        channel: &str,
        thread_ts: Option<&str>,
        text: &str,
        blocks: Option<&Value>,
    ) -> Result<String> {
        let mut body = json!({
            "channel": channel,
            "text": text,
            "unfurl_links": false,
            "unfurl_media": false,
        });
        if let Some(ts) = thread_ts {
            body["thread_ts"] = json!(ts);
        }
        if let Some(blocks) = blocks {
            body["blocks"] = blocks.clone();
        }
        let body = self.call_json("chat.postMessage", bot, &body).await?;
        Ok(body
            .get("ts")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    pub async fn update_message(
        &self,
        bot: &Secret,
        channel: &str,
        ts: &str,
        text: &str,
        blocks: Option<&Value>,
    ) -> Result<()> {
        let body = json!({
            "channel": channel,
            "ts": ts,
            "text": text,
            "blocks": blocks.cloned().unwrap_or_else(|| json!([])),
        });
        self.call_json("chat.update", bot, &body).await.map(|_| ())
    }

    /// A message only `user` sees, in the thread of `thread_ts`.
    pub async fn post_ephemeral(
        &self,
        bot: &Secret,
        channel: &str,
        user: &str,
        thread_ts: Option<&str>,
        text: &str,
    ) -> Result<()> {
        let mut body = json!({ "channel": channel, "user": user, "text": text });
        if let Some(ts) = thread_ts {
            body["thread_ts"] = json!(ts);
        }
        self.call_json("chat.postEphemeral", bot, &body)
            .await
            .map(|_| ())
    }

    /// The direct-message channel between the bot and `user`.
    pub async fn open_dm(&self, bot: &Secret, user: &str) -> Result<String> {
        let body = self
            .call("conversations.open", bot, &[("users", user)])
            .await?;
        body.pointer("/channel/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow!("Slack conversations.open answered without a channel id"))
    }

    /// Opens a modal; `trigger_id` comes from a click and expires in seconds.
    pub async fn open_view(&self, bot: &Secret, trigger_id: &str, view: &Value) -> Result<()> {
        let body = json!({ "trigger_id": trigger_id, "view": view });
        self.call_json("views.open", bot, &body).await.map(|_| ())
    }

    /// An `already_reacted` answer is success: the reaction is there.
    pub async fn add_reaction(
        &self,
        bot: &Secret,
        channel: &str,
        ts: &str,
        name: &str,
    ) -> Result<()> {
        match self
            .call(
                "reactions.add",
                bot,
                &[("channel", channel), ("timestamp", ts), ("name", name)],
            )
            .await
        {
            Err(e) if e.to_string().ends_with("already_reacted") => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// A `no_reaction` answer is success: the reaction is gone.
    pub async fn remove_reaction(
        &self,
        bot: &Secret,
        channel: &str,
        ts: &str,
        name: &str,
    ) -> Result<()> {
        match self
            .call(
                "reactions.remove",
                bot,
                &[("channel", channel), ("timestamp", ts), ("name", name)],
            )
            .await
        {
            Err(e) if e.to_string().ends_with("no_reaction") => Ok(()),
            other => other.map(|_| ()),
        }
    }

    pub async fn permalink(&self, bot: &Secret, channel: &str, ts: &str) -> Result<String> {
        let body = self
            .call(
                "chat.getPermalink",
                bot,
                &[("channel", channel), ("message_ts", ts)],
            )
            .await?;
        Ok(body
            .get("permalink")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    /// One page of a channel's messages after `oldest`, newest first as Slack
    /// returns them.
    pub async fn history(
        &self,
        bot: &Secret,
        channel: &str,
        oldest: &str,
        cursor: Option<&str>,
    ) -> Result<Page> {
        let mut form = vec![
            ("channel", channel),
            ("oldest", oldest),
            ("inclusive", "false"),
            ("limit", "200"),
        ];
        if let Some(c) = cursor {
            form.push(("cursor", c));
        }
        page(self.call("conversations.history", bot, &form).await?)
    }

    /// One page of a thread's replies after `oldest`, oldest first.
    pub async fn replies(
        &self,
        bot: &Secret,
        channel: &str,
        thread_ts: &str,
        oldest: &str,
        cursor: Option<&str>,
    ) -> Result<Page> {
        let mut form = vec![
            ("channel", channel),
            ("ts", thread_ts),
            ("oldest", oldest),
            ("inclusive", "false"),
            ("limit", "200"),
        ];
        if let Some(c) = cursor {
            form.push(("cursor", c));
        }
        page(self.call("conversations.replies", bot, &form).await?)
    }

    /// Streams a file into memory, refusing it as soon as it passes `max_bytes`.
    pub async fn download(&self, bot: &Secret, raw_url: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let url = check_file_url(raw_url)?;
        let resp = self
            .http
            .get(url)
            .bearer_auth(bot.expose())
            .send()
            .await
            .map_err(|e| anyhow!("downloading a Slack file failed: {}", e.without_url()))?;
        if !resp.status().is_success() {
            bail!("downloading a Slack file returned HTTP {}", resp.status());
        }
        let mut out = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| anyhow!("downloading a Slack file failed: {}", e.without_url()))?;
            if out.len() as u64 + chunk.len() as u64 > max_bytes {
                bail!("a Slack file is over the {max_bytes}-byte download limit; it was not saved");
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}

fn page(body: Value) -> Result<Page> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let next_cursor = body
        .pointer("/response_metadata/next_cursor")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    Ok(Page {
        messages,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_urls_must_be_wss_unless_loopback() {
        assert!(check_socket_url("wss://wss-primary.slack.com/link/?ticket=x").is_ok());
        assert!(check_socket_url("ws://127.0.0.1:4000/socket").is_ok());
        let err = check_socket_url("ws://evil.example/socket")
            .unwrap_err()
            .to_string();
        assert!(err.contains("ws://"), "{err}");
    }

    #[test]
    fn the_bot_token_only_goes_to_slack_file_hosts() {
        assert!(check_file_url("https://files.slack.com/files-pri/T1-F1/download/a.png").is_ok());
        assert!(check_file_url("http://127.0.0.1:9/files/a.png").is_ok());
        for bad in [
            "https://files.slack.com.evil.example/a.png",
            "http://files.slack.com/a.png",
            "https://example.com/a.png",
        ] {
            assert!(check_file_url(bad).is_err(), "{bad}");
        }
    }
}
