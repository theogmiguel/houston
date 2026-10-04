//! Turns a Slack event (live or replayed from history) into what the daemon
//! should do with it. Pure: identity, channel map and owner come in as `Scope`,
//! so every refusal is a unit test, not a live Slack round trip.

use serde_json::Value;
use std::collections::HashSet;

/// The reaction that accepts a request; only the owner's counts.
pub const ACCEPT_REACTION: &str = "white_check_mark";

pub struct Scope<'a> {
    pub team_id: &'a str,
    pub bot_user_id: &'a str,
    pub owner: Option<&'a str>,
    pub channels: &'a HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef {
    pub name: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// A top-level mention of the bot: a new pending request.
    Request {
        channel: String,
        ts: String,
        author: String,
        text: String,
        files: Vec<FileRef>,
    },
    /// The owner's ✅ on a message (the request it names, if any).
    Accept {
        channel: String,
        ts: String,
    },
    /// A reply in some thread; the daemon decides whether a question awaits it.
    Reply {
        channel: String,
        thread_ts: String,
        ts: String,
        author: String,
        text: String,
    },
    Ignore(&'static str),
}

fn s<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).and_then(Value::as_str).filter(|x| !x.is_empty())
}

/// Messages from another organisation's members (a shared channel) carry
/// their own team; one that differs from ours is never acted on.
fn foreign_team(event: &Value, scope: &Scope) -> bool {
    ["team", "user_team", "source_team"]
        .iter()
        .filter_map(|k| s(event, k))
        .any(|t| t != scope.team_id)
}

fn authored_by_a_bot(event: &Value, scope: &Scope) -> bool {
    event.get("bot_id").is_some()
        || s(event, "subtype") == Some("bot_message")
        || s(event, "user") == Some(scope.bot_user_id)
}

/// Edits, deletions, joins and the like never create or answer anything.
fn plain_message(event: &Value) -> bool {
    matches!(
        s(event, "subtype"),
        None | Some("file_share" | "thread_broadcast")
    )
}

/// The text as the person typed it: Slack sends `&`, `<` and `>` escaped,
/// and Houston escapes again wherever it writes text back.
pub fn strip_mention(text: &str, bot_user_id: &str) -> String {
    text.replace(&format!("<@{bot_user_id}>"), " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn files(event: &Value) -> Vec<FileRef> {
    event
        .get("files")
        .and_then(Value::as_array)
        .map(|fs| {
            fs.iter()
                .filter_map(|f| {
                    Some(FileRef {
                        name: s(f, "name").unwrap_or("file").to_string(),
                        size: f.get("size").and_then(Value::as_u64).unwrap_or(0),
                        url: s(f, "url_private_download")?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn message_intent(channel: &str, event: &Value, scope: &Scope, mentioned: bool) -> Intent {
    if !plain_message(event) {
        return Intent::Ignore("edited, deleted or system message");
    }
    if authored_by_a_bot(event, scope) {
        return Intent::Ignore("message from a bot");
    }
    let (Some(ts), Some(author)) = (s(event, "ts"), s(event, "user")) else {
        return Intent::Ignore("message without ts or user");
    };
    let text = s(event, "text").unwrap_or_default();
    match s(event, "thread_ts").filter(|t| *t != ts) {
        Some(thread_ts) => Intent::Reply {
            channel: channel.to_string(),
            thread_ts: thread_ts.to_string(),
            ts: ts.to_string(),
            author: author.to_string(),
            text: strip_mention(text, scope.bot_user_id),
        },
        None if mentioned => Intent::Request {
            channel: channel.to_string(),
            ts: ts.to_string(),
            author: author.to_string(),
            text: strip_mention(text, scope.bot_user_id),
            files: files(event),
        },
        None => Intent::Ignore("top-level message without a mention"),
    }
}

/// A live `events_api` payload's `event`.
pub fn classify(event: &Value, scope: &Scope) -> Intent {
    if foreign_team(event, scope) {
        return Intent::Ignore("event from another Slack team");
    }
    match s(event, "type") {
        Some("reaction_added") => {
            let item = event.get("item").cloned().unwrap_or(Value::Null);
            let (Some(channel), Some(ts)) = (s(&item, "channel"), s(&item, "ts")) else {
                return Intent::Ignore("reaction on something other than a message");
            };
            if !scope.channels.contains(channel) {
                return Intent::Ignore("channel not mapped to a workspace");
            }
            if s(event, "reaction") != Some(ACCEPT_REACTION) {
                return Intent::Ignore("reaction other than the accept reaction");
            }
            if scope.owner.is_none() || s(event, "user") != scope.owner {
                return Intent::Ignore("accept reaction from someone other than the owner");
            }
            Intent::Accept {
                channel: channel.to_string(),
                ts: ts.to_string(),
            }
        }
        Some(kind @ ("app_mention" | "message")) => {
            let Some(channel) = s(event, "channel") else {
                return Intent::Ignore("message without a channel");
            };
            if !scope.channels.contains(channel) {
                return Intent::Ignore("channel not mapped to a workspace");
            }
            message_intent(channel, event, scope, kind == "app_mention")
        }
        _ => Intent::Ignore("event type the intake does not handle"),
    }
}

/// A message from `conversations.history` or `.replies`, replayed after a
/// reconnect: a mention is a request, and the owner's ✅ already on it is an
/// acceptance that happened while the connection was down.
pub fn classify_history(channel: &str, msg: &Value, scope: &Scope) -> Vec<Intent> {
    if foreign_team(msg, scope) || !scope.channels.contains(channel) {
        return Vec::new();
    }
    let mentioned =
        s(msg, "text").is_some_and(|t| t.contains(&format!("<@{}>", scope.bot_user_id)));
    let mut out = Vec::new();
    match message_intent(channel, msg, scope, mentioned) {
        Intent::Ignore(_) => {}
        intent => out.push(intent),
    }
    let accepted = scope.owner.is_some_and(|owner| {
        msg.get("reactions")
            .and_then(Value::as_array)
            .is_some_and(|rs| {
                rs.iter().any(|r| {
                    s(r, "name") == Some(ACCEPT_REACTION)
                        && r.get("users")
                            .and_then(Value::as_array)
                            .is_some_and(|us| us.iter().any(|u| u.as_str() == Some(owner)))
                })
            })
    });
    if accepted {
        if let Some(ts) = s(msg, "ts") {
            out.push(Intent::Accept {
                channel: channel.to_string(),
                ts: ts.to_string(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope(channels: &HashSet<String>) -> Scope<'_> {
        Scope {
            team_id: "T1",
            bot_user_id: "UBOT",
            owner: Some("UOWNER"),
            channels,
        }
    }

    fn mapped() -> HashSet<String> {
        HashSet::from(["C1".to_string()])
    }

    #[test]
    fn a_top_level_mention_is_a_request_with_the_mention_stripped() {
        let ch = mapped();
        let ev = json!({"type": "app_mention", "channel": "C1", "user": "U2", "team": "T1",
            "ts": "10.1", "text": "<@UBOT>  fix the   footer &amp; the &lt;h1&gt;",
            "files": [{"name": "a.png", "size": 12, "url_private_download": "https://files.slack.com/a.png"}]});
        assert_eq!(
            classify(&ev, &scope(&ch)),
            Intent::Request {
                channel: "C1".into(),
                ts: "10.1".into(),
                author: "U2".into(),
                text: "fix the footer & the <h1>".into(),
                files: vec![FileRef {
                    name: "a.png".into(),
                    size: 12,
                    url: "https://files.slack.com/a.png".into()
                }],
            }
        );
    }

    #[test]
    fn bots_edits_other_teams_and_unmapped_channels_are_ignored() {
        let ch = mapped();
        let sc = scope(&ch);
        let base = json!({"type": "app_mention", "channel": "C1", "user": "U2", "ts": "1.1", "text": "<@UBOT> x"});
        let with = |k: &str, v: Value| {
            let mut e = base.clone();
            e[k] = v;
            e
        };
        for (ev, why) in [
            (with("bot_id", json!("B1")), "message from a bot"),
            (with("user", json!("UBOT")), "message from a bot"),
            (
                with("subtype", json!("message_changed")),
                "edited, deleted or system message",
            ),
            (with("team", json!("T2")), "event from another Slack team"),
            (
                with("user_team", json!("T2")),
                "event from another Slack team",
            ),
            (
                with("channel", json!("C9")),
                "channel not mapped to a workspace",
            ),
        ] {
            assert_eq!(classify(&ev, &sc), Intent::Ignore(why), "{ev}");
        }
    }

    #[test]
    fn a_plain_top_level_message_is_not_a_request_but_a_thread_reply_is_a_reply() {
        let ch = mapped();
        let sc = scope(&ch);
        let top =
            json!({"type": "message", "channel": "C1", "user": "U2", "ts": "2.1", "text": "hi"});
        assert!(matches!(classify(&top, &sc), Intent::Ignore(_)));
        let reply = json!({"type": "message", "channel": "C1", "user": "U2", "ts": "2.2", "thread_ts": "1.1", "text": "blue"});
        assert_eq!(
            classify(&reply, &sc),
            Intent::Reply {
                channel: "C1".into(),
                thread_ts: "1.1".into(),
                ts: "2.2".into(),
                author: "U2".into(),
                text: "blue".into()
            }
        );
    }

    #[test]
    fn only_the_owners_check_mark_accepts() {
        let ch = mapped();
        let sc = scope(&ch);
        let react = |user: &str, name: &str| {
            json!({"type": "reaction_added", "user": user, "reaction": name,
                "item": {"type": "message", "channel": "C1", "ts": "1.1"}})
        };
        assert_eq!(
            classify(&react("UOWNER", ACCEPT_REACTION), &sc),
            Intent::Accept {
                channel: "C1".into(),
                ts: "1.1".into()
            }
        );
        assert!(matches!(
            classify(&react("U2", ACCEPT_REACTION), &sc),
            Intent::Ignore(_)
        ));
        assert!(matches!(
            classify(&react("UOWNER", "eyes"), &sc),
            Intent::Ignore(_)
        ));
        let no_owner = Scope {
            owner: None,
            ..scope(&ch)
        };
        assert!(matches!(
            classify(&react("UOWNER", ACCEPT_REACTION), &no_owner),
            Intent::Ignore(_)
        ));
    }

    #[test]
    fn history_replays_a_mention_and_an_owner_check_mark_made_while_offline() {
        let ch = mapped();
        let sc = scope(&ch);
        let msg = json!({"type": "message", "user": "U2", "ts": "3.1", "text": "<@UBOT> add a button",
            "reactions": [{"name": ACCEPT_REACTION, "users": ["U2", "UOWNER"], "count": 2}]});
        let got = classify_history("C1", &msg, &sc);
        assert!(matches!(&got[0], Intent::Request { ts, .. } if ts == "3.1"));
        assert_eq!(
            got[1],
            Intent::Accept {
                channel: "C1".into(),
                ts: "3.1".into()
            }
        );
        let not_mentioned = json!({"type": "message", "user": "U2", "ts": "3.2", "text": "lunch?"});
        assert!(classify_history("C1", &not_mentioned, &sc).is_empty());
    }
}
