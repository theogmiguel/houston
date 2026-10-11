//! Push notifications through an ntfy topic. The topic URL is a bearer secret,
//! so it lives in the OS keychain under a per-state-directory service and only
//! its server origin is stored or logged.
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Result};
use zeroize::Zeroizing;

use super::{hash_secret, NotifyDetail};

const ENTRY: &str = "ntfy-url";
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const PANE_NAME_MAX: usize = 80;

/// One service per state directory, so a development daemon never reads or
/// replaces the installed one's topic.
fn service(state_dir: &Path) -> String {
    let digest = hash_secret(&state_dir.to_string_lossy());
    format!("houston-remote-{}", &digest[..16])
}

fn entry(state_dir: &Path) -> Result<keyring::Entry> {
    keyring::Entry::new(&service(state_dir), ENTRY)
        .map_err(|e| anyhow!("opening the OS keychain for the ntfy topic URL: {e}"))
}

pub fn store_url(state_dir: &Path, url: &str) -> Result<()> {
    entry(state_dir)?
        .set_password(url)
        .map_err(|e| anyhow!("storing the ntfy topic URL in the OS keychain: {e}"))
}

pub fn load_url(state_dir: &Path) -> Result<Option<Zeroizing<String>>> {
    match entry(state_dir)?.get_password() {
        Ok(url) => Ok(Some(Zeroizing::new(url))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!(
            "reading the ntfy topic URL from the OS keychain: {e}"
        )),
    }
}

pub fn delete_url(state_dir: &Path) -> Result<()> {
    match entry(state_dir)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!(
            "removing the ntfy topic URL from the OS keychain: {e}"
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    NeedsInput,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub body: String,
    pub click: String,
    pub priority: &'static str,
    pub tags: &'static str,
}

/// Never terminal content, commands or paths: the generic body says only that
/// an agent waits, and `pane_name` adds the pane's title.
pub fn compose(
    kind: Kind,
    detail: NotifyDetail,
    pane_name: &str,
    open_url: &str,
    session: u32,
) -> Message {
    let name: String = pane_name
        .chars()
        .filter(|c| !c.is_control())
        .take(PANE_NAME_MAX)
        .collect();
    let name = name.trim();
    let named = detail == NotifyDetail::PaneName && !name.is_empty();
    let body = match (kind, named) {
        (Kind::NeedsInput, false) => "An agent needs your input".to_string(),
        (Kind::NeedsInput, true) => format!("{name} needs your input"),
        (Kind::Finished, false) => "An agent finished its turn".to_string(),
        (Kind::Finished, true) => format!("{name} finished its turn"),
    };
    Message {
        body,
        click: format!("{open_url}/#session={session}"),
        priority: match kind {
            Kind::NeedsInput => "high",
            Kind::Finished => "default",
        },
        tags: match kind {
            Kind::NeedsInput => "warning",
            Kind::Finished => "white_check_mark",
        },
    }
}

pub async fn send(client: &reqwest::Client, topic_url: &str, msg: &Message) -> Result<(), String> {
    let resp = client
        .post(topic_url)
        .header("Title", "Houston")
        .header("Priority", msg.priority)
        .header("Tags", msg.tags)
        .header("Click", &msg.click)
        .body(msg.body.clone())
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!("server answered {}", resp.status()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generic_message_names_nothing() {
        let m = compose(
            Kind::NeedsInput,
            NotifyDetail::Generic,
            "deploy prod",
            "https://box.ts.net",
            7,
        );
        assert_eq!(m.body, "An agent needs your input");
        assert_eq!(m.click, "https://box.ts.net/#session=7");
        assert_eq!(m.priority, "high");
    }

    #[test]
    fn the_pane_name_detail_is_cleaned_and_capped() {
        let m = compose(
            Kind::Finished,
            NotifyDetail::PaneName,
            &format!("a\u{1b}b{}", "x".repeat(200)),
            "http://127.0.0.1:47823",
            1,
        );
        assert!(m.body.starts_with("ab"));
        assert!(!m.body.contains('\u{1b}'));
        assert!(m.body.chars().count() <= PANE_NAME_MAX + " finished its turn".len());
    }

    #[test]
    fn services_differ_per_state_directory() {
        assert_ne!(
            service(Path::new("/home/u/.houston")),
            service(Path::new("/home/u/.houston-dev"))
        );
    }
}
