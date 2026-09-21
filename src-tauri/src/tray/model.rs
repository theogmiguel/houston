use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayConnection {
    Connecting,
    Ready,
    Reconnecting,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayStatus {
    Running,
    Idle,
    NeedsInput,
    Unknown,
    Done,
    Error,
}

impl TrayStatus {
    pub fn glyph(self) -> char {
        match self {
            TrayStatus::Running => '●',
            TrayStatus::Idle => '○',
            TrayStatus::NeedsInput => '◐',
            TrayStatus::Unknown => '?',
            TrayStatus::Done => '✓',
            TrayStatus::Error => '✕',
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySession {
    pub id: i64,
    pub agent: String,
    pub title: String,
    pub status: TrayStatus,
    pub needs_input: bool,
    pub workspace: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPayload {
    pub connection: TrayConnection,
    pub sessions: Vec<TraySession>,
}

impl TrayPayload {
    pub fn connecting() -> Self {
        TrayPayload {
            connection: TrayConnection::Connecting,
            sessions: Vec::new(),
        }
    }
}

// Caps keep the OS tray menu short and glanceable; the rest collapse into
// an overflow row rather than growing the menu unbounded.
pub const ATTENTION_ROW_CAP: usize = 4;
pub const GROUP_ROW_CAP: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayIconState {
    Idle,
    Active,
    Attention,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayItem {
    Header(String),
    Open,
    Separator,
    Session { id: i64, label: String },
    Overflow(String),
    Group(String),
    Submenu { label: String, items: Vec<TrayItem> },
    StopDaemon,
}

pub fn agent_label(kind: &str) -> String {
    match kind {
        "claude" => "Claude".into(),
        "codex" => "Codex".into(),
        "antigravity" => "Antigravity".into(),
        "shell" => "Shell".into(),
        "custom" => "Custom".into(),
        "opencode" => "OpenCode".into(),
        "cursor" => "Cursor".into(),
        "grok" => "Grok".into(),
        "droid" => "Droid".into(),
        "copilot" => "Copilot".into(),
        "aider" => "Aider".into(),
        "ssh" => "SSH".into(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Agent".into(),
            }
        }
    }
}

fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

fn running_count(payload: &TrayPayload) -> usize {
    payload
        .sessions
        .iter()
        .filter(|s| s.status == TrayStatus::Running)
        .count()
}

fn attention_count(payload: &TrayPayload) -> usize {
    payload.sessions.iter().filter(|s| s.needs_input).count()
}

fn unknown_count(payload: &TrayPayload) -> usize {
    payload
        .sessions
        .iter()
        .filter(|s| s.status == TrayStatus::Unknown)
        .count()
}

pub fn header_text(payload: &TrayPayload) -> String {
    match payload.connection {
        TrayConnection::Failed => "Houston · daemon not running".into(),
        TrayConnection::Connecting | TrayConnection::Reconnecting => {
            "Houston · disconnected".into()
        }
        TrayConnection::Ready => {
            if payload.sessions.is_empty() {
                return "Houston · idle".into();
            }
            let running = running_count(payload);
            let attention = attention_count(payload);
            let mut parts: Vec<String> = Vec::new();
            if running > 0 {
                parts.push(format!("{} running", plural(running, "agent")));
            }
            if attention > 0 {
                parts.push(if attention == 1 {
                    "1 needs input".to_string()
                } else {
                    format!("{attention} need input")
                });
            }
            let unknown = unknown_count(payload);
            if unknown > 0 {
                parts.push(format!("{unknown} status unknown"));
            }
            if parts.is_empty() {
                parts.push(format!("{} idle", plural(payload.sessions.len(), "agent")));
            }
            format!("Houston · {}", parts.join(" · "))
        }
    }
}

pub fn icon_state(payload: &TrayPayload) -> TrayIconState {
    if attention_count(payload) > 0 {
        return TrayIconState::Attention;
    }
    if payload.connection == TrayConnection::Ready && running_count(payload) > 0 {
        TrayIconState::Active
    } else {
        TrayIconState::Idle
    }
}

pub fn session_label(session: &TraySession) -> String {
    format!(
        "{} {} — {}",
        session.status.glyph(),
        agent_label(&session.agent),
        session.title
    )
}

fn status_rank(status: TrayStatus) -> u8 {
    match status {
        TrayStatus::NeedsInput => 0,
        TrayStatus::Running => 1,
        TrayStatus::Unknown => 2,
        TrayStatus::Idle => 3,
        TrayStatus::Done | TrayStatus::Error => 4,
    }
}

fn agents_submenu(sessions: &[TraySession]) -> Vec<TrayItem> {
    let mut order: Vec<&str> = Vec::new();
    let mut groups: std::collections::HashMap<&str, Vec<&TraySession>> =
        std::collections::HashMap::new();
    for session in sessions {
        groups
            .entry(session.workspace.as_str())
            .or_insert_with(|| {
                order.push(session.workspace.as_str());
                Vec::new()
            })
            .push(session);
    }

    let mut items = Vec::new();
    for (i, workspace) in order.iter().enumerate() {
        if i > 0 {
            items.push(TrayItem::Separator);
        }
        items.push(TrayItem::Group((*workspace).to_string()));
        let mut panes = groups[workspace].clone();
        panes.sort_by_key(|s| status_rank(s.status));
        for session in panes.iter().take(GROUP_ROW_CAP) {
            items.push(TrayItem::Session {
                id: session.id,
                label: session_label(session),
            });
        }
        if panes.len() > GROUP_ROW_CAP {
            let hidden = panes.len() - GROUP_ROW_CAP;
            items.push(TrayItem::Overflow(format!("+{hidden} more in Houston")));
        }
    }
    items
}

pub fn menu_model(payload: &TrayPayload) -> Vec<TrayItem> {
    let mut items = vec![
        TrayItem::Header(header_text(payload)),
        TrayItem::Open,
        TrayItem::Separator,
    ];

    let attention: Vec<&TraySession> = payload.sessions.iter().filter(|s| s.needs_input).collect();
    for session in attention.iter().take(ATTENTION_ROW_CAP) {
        items.push(TrayItem::Session {
            id: session.id,
            label: session_label(session),
        });
    }
    if attention.len() > ATTENTION_ROW_CAP {
        let hidden = attention.len() - ATTENTION_ROW_CAP;
        items.push(TrayItem::Overflow(format!(
            "+{hidden} more waiting, in Agents"
        )));
    }

    if !payload.sessions.is_empty() {
        items.push(TrayItem::Submenu {
            label: format!("Agents ({})", payload.sessions.len()),
            items: agents_submenu(&payload.sessions),
        });
        items.push(TrayItem::Separator);
    }

    items.push(TrayItem::StopDaemon);
    items
}

pub fn stop_confirm_message(payload: &TrayPayload) -> String {
    if payload.connection != TrayConnection::Ready {
        return "This ends an unknown number of live sessions — Houston is not connected to the \
                daemon right now."
            .into();
    }
    let live = payload
        .sessions
        .iter()
        .filter(|s| !matches!(s.status, TrayStatus::Done | TrayStatus::Error))
        .count();
    format!(
        "This ends {} and stops the daemon. Reopening Houston starts a new daemon.",
        plural(live, "live session")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: i64, agent: &str, title: &str, status: TrayStatus) -> TraySession {
        session_in(id, agent, title, status, "houston")
    }

    fn session_in(
        id: i64,
        agent: &str,
        title: &str,
        status: TrayStatus,
        workspace: &str,
    ) -> TraySession {
        TraySession {
            id,
            agent: agent.into(),
            title: title.into(),
            status,
            needs_input: status == TrayStatus::NeedsInput,
            workspace: workspace.into(),
        }
    }

    fn ready(sessions: Vec<TraySession>) -> TrayPayload {
        TrayPayload {
            connection: TrayConnection::Ready,
            sessions,
        }
    }

    #[test]
    fn header_names_running_and_waiting_counts() {
        let payload = ready(vec![
            session(1, "claude", "refactor auth", TrayStatus::Running),
            session(2, "codex", "port the wire", TrayStatus::Running),
            session(3, "claude", "grid teardown", TrayStatus::Running),
            session(4, "claude", "release notes", TrayStatus::NeedsInput),
        ]);
        assert_eq!(
            header_text(&payload),
            "Houston · 3 agents running · 1 needs input"
        );
    }

    #[test]
    fn header_uses_the_singular_agent_and_the_plural_verb() {
        let one_running = ready(vec![session(1, "claude", "a", TrayStatus::Running)]);
        assert_eq!(header_text(&one_running), "Houston · 1 agent running");

        let two_waiting = ready(vec![
            session(1, "claude", "a", TrayStatus::NeedsInput),
            session(2, "codex", "b", TrayStatus::NeedsInput),
        ]);
        assert_eq!(header_text(&two_waiting), "Houston · 2 need input");
    }

    #[test]
    fn header_says_idle_with_no_sessions_and_names_the_count_with_only_quiet_ones() {
        assert_eq!(header_text(&ready(vec![])), "Houston · idle");
        assert_eq!(
            header_text(&ready(vec![
                session(1, "claude", "a", TrayStatus::Idle),
                session(2, "shell", "b", TrayStatus::Done),
            ])),
            "Houston · 2 agents idle"
        );
    }

    #[test]
    fn header_does_not_call_an_unreported_agent_idle() {
        assert_eq!(
            header_text(&ready(vec![
                session(1, "claude", "a", TrayStatus::Unknown,)
            ])),
            "Houston · 1 status unknown"
        );
    }

    #[test]
    fn header_names_the_connection_before_it_names_agents() {
        for (connection, expected) in [
            (TrayConnection::Failed, "Houston · daemon not running"),
            (TrayConnection::Connecting, "Houston · disconnected"),
            (TrayConnection::Reconnecting, "Houston · disconnected"),
        ] {
            let payload = TrayPayload {
                connection,
                sessions: vec![session(1, "claude", "a", TrayStatus::Running)],
            };
            assert_eq!(header_text(&payload), expected);
        }
    }

    #[test]
    fn every_status_has_its_own_glyph() {
        let all = [
            TrayStatus::Running,
            TrayStatus::Idle,
            TrayStatus::NeedsInput,
            TrayStatus::Unknown,
            TrayStatus::Done,
            TrayStatus::Error,
        ];
        let glyphs: Vec<char> = all.iter().map(|s| s.glyph()).collect();
        assert_eq!(glyphs, vec!['●', '○', '◐', '?', '✓', '✕']);
        let mut unique = glyphs.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            unique.len(),
            all.len(),
            "two states share a glyph: {glyphs:?}"
        );
    }

    #[test]
    fn a_session_row_is_glyph_then_agent_then_name() {
        assert_eq!(
            session_label(&session(
                7,
                "claude",
                "refactor auth",
                TrayStatus::NeedsInput
            )),
            "◐ Claude — refactor auth"
        );
        assert_eq!(
            session_label(&session(7, "opencode", "sweep", TrayStatus::Running)),
            "● OpenCode — sweep"
        );
    }

    #[test]
    fn an_unlisted_agent_kind_is_title_cased_rather_than_dropped() {
        assert_eq!(agent_label("someNewCli"), "SomeNewCli");
        assert_eq!(agent_label(""), "Agent");
    }

    #[test]
    fn an_idle_menu_has_one_separator_not_two_empty_ones() {
        let items = menu_model(&ready(vec![]));
        assert_eq!(
            items,
            vec![
                TrayItem::Header("Houston · idle".into()),
                TrayItem::Open,
                TrayItem::Separator,
                TrayItem::StopDaemon,
            ]
        );
    }

    fn submenu(items: &[TrayItem]) -> &[TrayItem] {
        items
            .iter()
            .find_map(|i| match i {
                TrayItem::Submenu { items, .. } => Some(items.as_slice()),
                _ => None,
            })
            .expect("menu_model always adds the Agents submenu when there is a session")
    }

    #[test]
    fn a_single_session_lives_in_the_submenu_not_at_the_top_level() {
        let items = menu_model(&ready(vec![session(1, "claude", "a", TrayStatus::Running)]));
        assert_eq!(
            items,
            vec![
                TrayItem::Header("Houston · 1 agent running".into()),
                TrayItem::Open,
                TrayItem::Separator,
                TrayItem::Submenu {
                    label: "Agents (1)".into(),
                    items: vec![
                        TrayItem::Group("houston".into()),
                        TrayItem::Session {
                            id: 1,
                            label: "● Claude — a".into(),
                        },
                    ],
                },
                TrayItem::Separator,
                TrayItem::StopDaemon,
            ],
            "the menu's shape must not change under the cursor as the fleet grows"
        );
    }

    #[test]
    fn attention_rows_sit_inline_at_the_top_capped_and_in_payload_order() {
        let sessions: Vec<TraySession> = (1..=6)
            .map(|i| session(i, "claude", &format!("pane {i}"), TrayStatus::NeedsInput))
            .collect();
        let items = menu_model(&ready(sessions));
        let inline: Vec<i64> = items
            .iter()
            .take_while(|i| !matches!(i, TrayItem::Submenu { .. }))
            .filter_map(|i| match i {
                TrayItem::Session { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            inline,
            vec![1, 2, 3, 4],
            "capped at ATTENTION_ROW_CAP, in the order given"
        );
        assert!(
            items.contains(&TrayItem::Overflow("+2 more waiting, in Agents".into())),
            "the overflow row must name the count it hid: {items:?}"
        );
    }

    #[test]
    fn exactly_at_the_attention_cap_there_is_no_overflow_row() {
        let sessions: Vec<TraySession> = (1..=ATTENTION_ROW_CAP as i64)
            .map(|i| session(i, "claude", "pane", TrayStatus::NeedsInput))
            .collect();
        let items = menu_model(&ready(sessions));
        assert!(!items.iter().any(|i| matches!(i, TrayItem::Overflow(_))));
    }

    #[test]
    fn a_running_pane_never_appears_at_the_top_level_only_a_waiting_one_does() {
        let items = menu_model(&ready(vec![
            session(1, "claude", "waiting", TrayStatus::NeedsInput),
            session(2, "codex", "running", TrayStatus::Running),
        ]));
        let top_level_ids: Vec<i64> = items
            .iter()
            .filter_map(|i| match i {
                TrayItem::Session { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            top_level_ids,
            vec![1],
            "only the waiting pane gets an inline shortcut"
        );
        let submenu_ids: Vec<i64> = submenu(&items)
            .iter()
            .filter_map(|i| match i {
                TrayItem::Session { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            submenu_ids,
            vec![1, 2],
            "both panes still show up in the submenu's full inventory"
        );
    }

    #[test]
    fn the_submenu_groups_by_workspace_in_first_appearance_order() {
        let items = menu_model(&ready(vec![
            session_in(1, "claude", "a", TrayStatus::Idle, "beta"),
            session_in(2, "codex", "b", TrayStatus::Idle, "alpha"),
            session_in(3, "shell", "c", TrayStatus::Idle, "beta"),
        ]));
        let groups: Vec<&str> = submenu(&items)
            .iter()
            .filter_map(|i| match i {
                TrayItem::Group(name) => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            groups,
            vec!["beta", "alpha"],
            "workspaces are grouped in the order they first appear in the payload"
        );
    }

    #[test]
    fn each_group_sorts_needs_input_then_running_then_idle_then_done_ties_keeping_payload_order() {
        let items = menu_model(&ready(vec![
            session_in(1, "claude", "idle-a", TrayStatus::Idle, "ws"),
            session_in(2, "codex", "done", TrayStatus::Done, "ws"),
            session_in(3, "shell", "running", TrayStatus::Running, "ws"),
            session_in(4, "claude", "needs-input", TrayStatus::NeedsInput, "ws"),
            session_in(5, "claude", "idle-b", TrayStatus::Idle, "ws"),
        ]));
        let ids: Vec<i64> = submenu(&items)
            .iter()
            .filter_map(|i| match i {
                TrayItem::Session { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec![4, 3, 1, 5, 2],
            "needs-input, running, idle (payload order), then done/error"
        );
    }

    #[test]
    fn the_group_cap_names_how_many_it_hid() {
        let sessions: Vec<TraySession> = (1..=(GROUP_ROW_CAP as i64 + 3))
            .map(|i| session_in(i, "claude", "pane", TrayStatus::Idle, "ws"))
            .collect();
        let items = menu_model(&ready(sessions));
        let sub = submenu(&items);
        let shown: Vec<i64> = sub
            .iter()
            .filter_map(|i| match i {
                TrayItem::Session { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(shown.len(), GROUP_ROW_CAP);
        assert_eq!(shown, (1..=GROUP_ROW_CAP as i64).collect::<Vec<i64>>());
        assert!(
            sub.contains(&TrayItem::Overflow("+3 more in Houston".into())),
            "the per-group overflow row must name the count it hid: {sub:?}"
        );
    }

    #[test]
    fn exactly_at_the_group_cap_there_is_no_overflow_row() {
        let sessions: Vec<TraySession> = (1..=GROUP_ROW_CAP as i64)
            .map(|i| session_in(i, "claude", "pane", TrayStatus::Idle, "ws"))
            .collect();
        let sub = menu_model(&ready(sessions));
        assert!(!submenu(&sub)
            .iter()
            .any(|i| matches!(i, TrayItem::Overflow(_))));
    }

    #[test]
    fn the_submenu_label_names_the_total_session_count() {
        let sessions: Vec<TraySession> = (1..=5)
            .map(|i| session(i, "claude", "pane", TrayStatus::Idle))
            .collect();
        let items = menu_model(&ready(sessions));
        assert!(
            items.contains(&TrayItem::Submenu {
                label: "Agents (5)".into(),
                items: submenu(&items).to_vec(),
            }),
            "the submenu label must count every session, not just the ones shown: {items:?}"
        );
    }

    #[test]
    fn attention_beats_activity_for_the_icon() {
        assert_eq!(icon_state(&ready(vec![])), TrayIconState::Idle);
        assert_eq!(
            icon_state(&ready(vec![session(1, "claude", "a", TrayStatus::Running)])),
            TrayIconState::Active
        );
        assert_eq!(
            icon_state(&ready(vec![
                session(1, "claude", "a", TrayStatus::Running),
                session(2, "codex", "b", TrayStatus::NeedsInput),
            ])),
            TrayIconState::Attention
        );
    }

    #[test]
    fn a_disconnected_tray_never_claims_agents_are_active() {
        let payload = TrayPayload {
            connection: TrayConnection::Reconnecting,
            sessions: vec![session(1, "claude", "a", TrayStatus::Running)],
        };
        assert_eq!(icon_state(&payload), TrayIconState::Idle);
    }

    #[test]
    fn the_stop_confirm_counts_live_sessions_only() {
        let message = stop_confirm_message(&ready(vec![
            session(1, "claude", "a", TrayStatus::Running),
            session(2, "codex", "b", TrayStatus::NeedsInput),
            session(3, "shell", "c", TrayStatus::Done),
        ]));
        assert!(
            message.starts_with("This ends 2 live sessions"),
            "counted the finished pane: {message}"
        );
    }

    #[test]
    fn the_stop_confirm_says_unknown_when_it_cannot_know() {
        let message = stop_confirm_message(&TrayPayload {
            connection: TrayConnection::Failed,
            sessions: vec![],
        });
        assert!(message.contains("unknown number"), "{message}");
    }

    #[test]
    fn a_payload_deserializes_from_the_renderers_camel_case() {
        let payload: TrayPayload = serde_json::from_str(
            r#"{"connection":"ready","sessions":[
                 {"id":3,"agent":"claude","title":"refactor auth",
                  "status":"needsInput","needsInput":true,"workspace":"houston"}]}"#,
        )
        .expect("the renderer's own shape must parse");
        assert_eq!(payload.connection, TrayConnection::Ready);
        assert_eq!(payload.sessions[0].status, TrayStatus::NeedsInput);
        assert!(payload.sessions[0].needs_input);
        assert_eq!(payload.sessions[0].workspace, "houston");
    }
}
