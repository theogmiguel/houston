mod common;

use common::{
    connect_and_hello, create_custom_msg, expect_created, next_control, start_daemon_with_handle,
    TOKEN,
};
use houston_protocol as proto;

async fn send(ws: &mut common::WsStream, msg: &proto::ClientMsg) {
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::text(
        serde_json::to_string(msg).unwrap(),
    ))
    .await
    .unwrap();
}

async fn next_error(ws: &mut common::WsStream) -> String {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::Error { message, .. } => return message,
            _ => continue,
        }
    }
}

async fn next_tag_list(ws: &mut common::WsStream) -> Vec<proto::TagInfo> {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::TagList { tags } => return tags,
            _ => continue,
        }
    }
}

fn tag_create(name: &str, color: &str) -> proto::ClientMsg {
    proto::ClientMsg::TagCreate {
        name: name.to_string(),
        color: color.to_string(),
    }
}

#[tokio::test]
async fn registry_flows_whole_and_refusals_name_the_limit() {
    let (addr, _dir, _daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let hello = next_control(&mut ws).await;
    match hello {
        proto::ServerMsg::HelloOk { tags, .. } => {
            assert!(
                tags.is_empty(),
                "a fresh daemon has an empty registry, got {tags:?}"
            );
        }
        other => panic!("expected hello_ok, got {other:?}"),
    }

    send(&mut ws, &tag_create("code review", "#a78bfa")).await;
    let tags = next_tag_list(&mut ws).await;
    assert_eq!(
        tags.len(),
        1,
        "the registry broadcast after a create carries the new tag"
    );
    assert_eq!(tags[0].name, "code review");
    assert_eq!(tags[0].color, "#a78bfa");

    send(&mut ws, &tag_create("CODE REVIEW", "#22d3ee")).await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains("CODE REVIEW"),
        "the refusal must carry the offending value: {err}"
    );

    send(&mut ws, &tag_create("other", "#123456")).await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains("#123456") && err.contains("TAG_PALETTE"),
        "the refusal must name the color and the palette: {err}"
    );

    let long = "x".repeat(proto::MAX_TAG_NAME_LEN + 1);
    send(&mut ws, &tag_create(&long, "#a78bfa")).await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains(&proto::MAX_TAG_NAME_LEN.to_string()),
        "the refusal must name the cap: {err}"
    );

    send(
        &mut ws,
        &proto::ClientMsg::TagUpdate {
            tag: tags[0].id,
            name: "review".into(),
            color: "#f472b6".into(),
        },
    )
    .await;
    let after = next_tag_list(&mut ws).await;
    assert_eq!(after.len(), 1, "an update must not duplicate rows");
    assert_eq!(after[0].name, "review");
    assert_eq!(after[0].id, tags[0].id, "the id is what sessions hold");
    assert_eq!(after[0].color, "#f472b6");

    let mut ws2 = connect_and_hello(addr, TOKEN).await;
    match next_control(&mut ws2).await {
        proto::ServerMsg::HelloOk { tags, .. } => {
            assert_eq!(tags.len(), 1, "late joiners see the registry at hello");
            assert_eq!(tags[0].name, "review");
        }
        other => panic!("expected hello_ok, got {other:?}"),
    }
}

#[tokio::test]
async fn session_tags_set_round_trips_and_refuses_bad_sets() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello = next_control(&mut ws).await;

    let dir = tempfile::tempdir().unwrap();
    send(
        &mut ws,
        &serde_json::from_str(&create_custom_msg(vec!["sh", "-c", "exec cat"], dir.path()))
            .unwrap(),
    )
    .await;
    let session = expect_created(&mut ws).await.id;

    send(&mut ws, &tag_create("renewals", "#22d3ee")).await;
    let registry = next_tag_list(&mut ws).await;
    let tag_id = registry[0].id;

    send(
        &mut ws,
        &proto::ClientMsg::SessionSetTags {
            session,
            tags: vec![tag_id],
        },
    )
    .await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionTagsSet { session: s, tags } => {
                assert_eq!(s, session);
                assert_eq!(tags, vec![tag_id]);
                break;
            }
            _ => continue,
        }
    }
    let listed = daemon.list().into_iter().find(|s| s.id == session).unwrap();
    assert_eq!(
        listed.tags,
        vec![tag_id],
        "the roster carries the ids, not names"
    );

    send(
        &mut ws,
        &proto::ClientMsg::SessionSetTags {
            session: 99999,
            tags: vec![tag_id],
        },
    )
    .await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains("99999"),
        "the refusal names the session: {err}"
    );

    send(
        &mut ws,
        &proto::ClientMsg::SessionSetTags {
            session,
            tags: vec![777],
        },
    )
    .await;
    let err = next_error(&mut ws).await;
    assert!(err.contains("777"), "the refusal names the tag id: {err}");

    send(
        &mut ws,
        &proto::ClientMsg::SessionSetTags {
            session,
            tags: vec![tag_id, tag_id],
        },
    )
    .await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains("twice"),
        "the refusal names the duplicate: {err}"
    );

    for i in 0..proto::MAX_TAGS_PER_SESSION {
        send(
            &mut ws,
            &tag_create(
                &format!("t{i}"),
                proto::TAG_PALETTE[i % proto::TAG_PALETTE.len()],
            ),
        )
        .await;
        let _ = next_tag_list(&mut ws).await;
    }
    send(&mut ws, &tag_create("one too many", proto::TAG_PALETTE[0])).await;
    let registry = next_tag_list(&mut ws).await;
    assert_eq!(registry.len(), 7);
    let six: Vec<u32> = registry
        .iter()
        .filter(|t| t.name != "one too many")
        .map(|t| t.id)
        .collect();
    assert_eq!(six.len(), 6);
    send(
        &mut ws,
        &proto::ClientMsg::SessionSetTags { session, tags: six },
    )
    .await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains("6") && err.contains("5"),
        "the refusal names the actual count and the cap: {err}"
    );
}

#[tokio::test]
async fn delete_cascades_and_respawn_carries_the_set() {
    let (addr, _dir, daemon) = start_daemon_with_handle().await;
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _hello = next_control(&mut ws).await;

    let dir = tempfile::tempdir().unwrap();
    send(
        &mut ws,
        &serde_json::from_str(&create_custom_msg(
            vec!["sh", "-c", "exec sleep 300"],
            dir.path(),
        ))
        .unwrap(),
    )
    .await;
    let session = expect_created(&mut ws).await.id;

    send(&mut ws, &tag_create("wait-human", "#f59e0b")).await;
    let registry = next_tag_list(&mut ws).await;
    let tag_id = registry[0].id;

    send(
        &mut ws,
        &proto::ClientMsg::SessionSetTags {
            session,
            tags: vec![tag_id],
        },
    )
    .await;
    let mut saw_set = false;
    for _ in 0..10 {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionTagsSet { session: s, .. } if s == session => {
                saw_set = true;
                break;
            }
            _ => continue,
        }
    }
    assert!(
        saw_set,
        "the set broadcast must reach the asking client too"
    );

    send(&mut ws, &proto::ClientMsg::TagDelete { tag: tag_id }).await;
    let mut got_deleted = false;
    let mut got_cascade = false;
    for _ in 0..10 {
        match next_control(&mut ws).await {
            proto::ServerMsg::TagDeleted { tag } if tag == tag_id => {
                got_deleted = true;
            }
            proto::ServerMsg::SessionTagsSet { session: s, tags } if s == session => {
                assert!(tags.is_empty(), "the cascade must detach, got {tags:?}");
                got_cascade = true;
            }
            _ => continue,
        }
        if got_deleted && got_cascade {
            break;
        }
    }
    assert!(got_deleted, "tag_deleted must ride the delete");
    assert!(
        got_cascade,
        "the detached session must get its own broadcast"
    );
    let listed = daemon.list().into_iter().find(|s| s.id == session).unwrap();
    assert!(listed.tags.is_empty(), "the roster reflects the detach");

    send(&mut ws, &proto::ClientMsg::TagDelete { tag: tag_id }).await;
    let err = next_error(&mut ws).await;
    assert!(
        err.contains(&tag_id.to_string()),
        "the refusal names the id: {err}"
    );

    daemon.kill(session).expect("kill before respawn");
    common::expect_state(&mut ws, session, proto::SessionState::Killed).await;
    let fresh = daemon
        .respawn(session, false, None, None, false)
        .expect("respawn");
    assert_ne!(fresh.id, session, "a respawn mints a fresh id");
    assert!(
        fresh.tags.is_empty(),
        "the tag was deleted above; a respawn of the UNTAGGED pane carries none"
    );

    send(&mut ws, &tag_create("carry", "#a78bfa")).await;
    let registry = next_tag_list(&mut ws).await;
    let carry_id = registry.iter().find(|t| t.name == "carry").unwrap().id;
    daemon
        .set_session_tags(fresh.id, vec![carry_id])
        .expect("tag the respawned pane");
    let again = daemon
        .respawn(fresh.id, false, None, None, true)
        .expect("force respawn of a live session");
    assert_ne!(again.id, fresh.id);
    assert_eq!(
        again.tags,
        vec![carry_id],
        "the tag set must survive a respawn across the fresh id"
    );
}
