use std::collections::HashMap;

use houston_protocol as proto;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DenyTarget {
    pub child: u32,
    pub episode_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstructionTarget {
    pub session: u32,
    pub instruction_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InstructionSession {
    pub session: u32,
}

pub(crate) fn session_id(value: u32) -> Result<(), String> {
    if value == 0 {
        return Err("session 0: expected a positive integer session id".into());
    }
    Ok(())
}

pub(crate) fn instruction_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(format!(
            "instruction_id {value:?}: expected 1–64 ASCII letters, digits, underscores or hyphens (an opaque instruction id)"
        ));
    }
    Ok(())
}

pub(crate) fn episode_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return Err(format!(
            "episode_id {value:?}: expected 1–64 ASCII letters, digits, colons, underscores or hyphens (an opaque input episode id)"
        ));
    }
    Ok(())
}

pub(crate) fn escalation_reason(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 2000 {
        return Err(format!(
            "reason {value:?}: expected nonblank text of at most 2000 characters"
        ));
    }
    Ok(())
}

pub(crate) fn prompt_output(
    acceptance: proto::InstructionAcceptance,
    source: String,
    status: Option<proto::AgentStatus>,
    mode: &str,
) -> Value {
    let queued = matches!(
        acceptance.state,
        proto::InstructionState::Queued | proto::InstructionState::HeldAfterRecovery
    );
    let held = (acceptance.state != proto::InstructionState::Delivered)
        .then(|| acceptance.hold_reason.clone())
        .flatten();
    json!({
        "instruction_id": acceptance.instruction_id,
        "accepted": acceptance.accepted,
        "state": acceptance.state,
        "request_id": acceptance.request_id,
        "hold_reason": acceptance.hold_reason,
        "mode": mode,
        "queued": queued,
        "held": held,
        "status_source": source,
        "status_after": status,
        "note": "accepted; inspect the instruction's current state for delivery or recovery holds; completion is separate",
    })
}

#[derive(Debug)]
pub(crate) struct CliDoor {
    pub method: &'static str,
    pub path: String,
    pub body: Option<Value>,
}

pub(crate) fn cli_door(
    command: &str,
    positional: &[String],
    flags: &HashMap<String, String>,
) -> anyhow::Result<CliDoor> {
    let raw_session = positional.first().map(String::as_str).unwrap_or("");
    let session = raw_session
        .parse::<u32>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{command} session {raw_session:?}: expected a positive integer session id"
            )
        })?;
    if command == "deny" {
        if positional.len() != 1 || flags.len() != 1 || !flags.contains_key("episode-id") {
            anyhow::bail!(
                "deny arguments {positional:?}, {flags:?}: expected hs-pane deny CHILD --episode-id ID"
            );
        }
        let id = &flags["episode-id"];
        episode_id(id).map_err(anyhow::Error::msg)?;
        return Ok(CliDoor {
            method: "POST",
            path: "/orchestrate/deny".into(),
            body: Some(json!({"child":session,"episode_id":id})),
        });
    }
    if command == "escalate" {
        if positional.len() != 1 || flags.len() != 1 || !flags.contains_key("reason") {
            anyhow::bail!(
                "escalate arguments {positional:?}, {flags:?}: expected hs-pane escalate CHILD --reason REASON"
            );
        }
        let reason = &flags["reason"];
        escalation_reason(reason).map_err(anyhow::Error::msg)?;
        return Ok(CliDoor {
            method: "POST",
            path: "/orchestrate/escalate".into(),
            body: Some(json!({"child":session,"reason":reason})),
        });
    }
    let list = command == "instruction-list";
    if !flags.is_empty() || positional.len() != if list { 1 } else { 2 } {
        anyhow::bail!(
            "{command} arguments {positional:?}, {flags:?}: expected hs-pane {command} SESSION{}",
            if list { "" } else { " INSTRUCTION_ID" }
        );
    }
    if list {
        return Ok(CliDoor {
            method: "GET",
            path: format!("/orchestrate/instruction-list?session={session}"),
            body: None,
        });
    }
    let id = &positional[1];
    instruction_id(id).map_err(anyhow::Error::msg)?;
    if command == "instruction-get" {
        return Ok(CliDoor {
            method: "GET",
            path: format!("/orchestrate/instruction-get?session={session}&instruction_id={id}"),
            body: None,
        });
    }
    Ok(CliDoor {
        method: "POST",
        path: format!("/orchestrate/{command}"),
        body: Some(json!({"session":session,"instruction_id":id})),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_opaque_and_safe_in_paths() {
        for id in ["a", "018c4f4b-ea21-787e-b169-852ddbc5c203", "A_0-z"] {
            assert!(instruction_id(id).is_ok(), "{id}");
        }
        assert!(instruction_id(&"a".repeat(64)).is_ok());
        for id in ["", "../id", "a&session=2", "a b", "é", &"a".repeat(65)] {
            let error = instruction_id(id).unwrap_err();
            assert!(error.contains(&format!("{id:?}")), "{error}");
            assert!(error.contains("expected"), "{error}");
        }
    }

    #[test]
    fn escalation_validates_nonblank_character_limit() {
        assert!(escalation_reason(&"é".repeat(2000)).is_ok());
        for reason in [" \n", &"x".repeat(2001)] {
            assert!(escalation_reason(reason).is_err());
        }
        let flags = HashMap::from([("reason".into(), "Need a budget decision".into())]);
        let door = cli_door("escalate", &["12".into()], &flags).unwrap();
        assert_eq!(door.method, "POST");
        assert_eq!(door.path, "/orchestrate/escalate");
        assert_eq!(
            door.body.unwrap(),
            json!({"child":12,"reason":"Need a budget decision"})
        );
        assert!(cli_door("escalate", &["12".into()], &HashMap::new()).is_err());
    }

    #[test]
    fn episode_ids_accept_provider_identity_without_relaxing_instruction_ids() {
        for id in [
            "provider:12:1",
            "report:123",
            "input-episode_1",
            &"a".repeat(64),
        ] {
            assert!(episode_id(id).is_ok(), "{id}");
        }
        assert!(instruction_id("provider:12:1").is_err());
        for id in ["", "../bad", "a&child=2", "a b", "é", &"a".repeat(65)] {
            let error = episode_id(id).unwrap_err();
            assert!(
                error.contains(&format!("{id:?}")) && error.contains("expected"),
                "{error}"
            );
        }
    }

    #[test]
    fn deny_cli_requires_an_exact_episode_target() {
        let flags = HashMap::from([("episode-id".into(), "provider:12:1".into())]);
        let door = cli_door("deny", &["12".into()], &flags).unwrap();
        assert_eq!(door.method, "POST");
        assert_eq!(door.path, "/orchestrate/deny");
        assert_eq!(
            door.body.unwrap(),
            json!({"child":12,"episode_id":"provider:12:1"})
        );
        for id in ["", "../episode", "a b", &"a".repeat(65)] {
            let flags = HashMap::from([("episode-id".into(), id.into())]);
            let error = cli_door("deny", &["12".into()], &flags)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(&format!("{id:?}")) && error.contains("expected"),
                "{error}"
            );
        }
        assert!(cli_door("deny", &["12".into()], &HashMap::new()).is_err());
        assert!(cli_door("deny", &["12".into(), "extra".into()], &flags).is_err());
    }

    #[test]
    fn instruction_cli_preserves_target_and_method() {
        for (command, method) in [
            ("instruction-list", "GET"),
            ("instruction-get", "GET"),
            ("instruction-cancel", "POST"),
            ("instruction-resume", "POST"),
        ] {
            let mut args = vec!["12".into()];
            if command != "instruction-list" {
                args.push("opaque-id".into());
            }
            let door = cli_door(command, &args, &HashMap::new()).unwrap();
            assert_eq!(door.method, method);
            if method == "POST" {
                assert_eq!(
                    door.body.unwrap(),
                    json!({"session":12,"instruction_id":"opaque-id"})
                );
            } else {
                assert!(door
                    .path
                    .starts_with(&format!("/orchestrate/{command}?session=12")));
                if command == "instruction-get" {
                    assert!(door.path.ends_with("&instruction_id=opaque-id"));
                }
            }
        }
    }

    #[test]
    fn cli_refuses_missing_ids_and_query_injection() {
        for args in [
            vec!["0".into()],
            vec!["-1".into()],
            vec!["4294967296".into()],
        ] {
            let error = cli_door("instruction-list", &args, &HashMap::new()).unwrap_err();
            assert!(error.to_string().contains("positive integer"));
        }
        for args in [vec!["12".into()], vec!["12".into(), "a&session=99".into()]] {
            assert!(cli_door("instruction-get", &args, &HashMap::new()).is_err());
        }
    }

    #[test]
    fn prompt_response_preserves_acceptance_id_and_current_state_with_compatibility_fields() {
        for state in [
            proto::InstructionState::Queued,
            proto::InstructionState::HeldAfterRecovery,
            proto::InstructionState::Delivered,
            proto::InstructionState::Cancelled,
            proto::InstructionState::Uncertain,
        ] {
            let response = prompt_output(
                proto::InstructionAcceptance {
                    instruction_id: "same-intent-id".into(),
                    accepted: true,
                    state,
                    request_id: Some(3),
                    hold_reason: Some("current reason".into()),
                },
                "hooks-full".into(),
                Some(proto::AgentStatus::Working),
                "queue",
            );
            assert_eq!(response["instruction_id"], json!("same-intent-id"));
            assert_eq!(response["accepted"], json!(true));
            assert_eq!(response["state"], serde_json::to_value(state).unwrap());
            if state == proto::InstructionState::Delivered {
                assert!(response["held"].is_null());
            } else {
                assert_eq!(response["hold_reason"], response["held"]);
            }
            assert_eq!(
                response["queued"],
                json!(matches!(
                    state,
                    proto::InstructionState::Queued | proto::InstructionState::HeldAfterRecovery
                ))
            );
            assert_eq!(response["status_source"], json!("hooks-full"));
            assert_eq!(response["request_id"], json!(3));
            assert!(response["note"]
                .as_str()
                .unwrap()
                .contains("completion is separate"));
        }
    }
}
