mod common;

use common::*;
use futures_util::SinkExt;
use houston_protocol as proto;
use tokio_tungstenite::tungstenite::Message;

async fn generate(ws: &mut WsStream, session: u32, cmd: Vec<&str>) {
    let msg = serde_json::to_string(&proto::ClientMsg::HandoffGenerate {
        session,
        provider: proto::AgentKind::Custom,
        cmd: Some(cmd.into_iter().map(String::from).collect()),
    })
    .unwrap();
    ws.send(Message::text(msg)).await.unwrap();
}

fn source_argv(marker: &str) -> Vec<&'static str> {
    #[cfg(unix)]
    {
        if marker == "the-source-history" {
            vec!["sh", "-c", "echo the-source-history; sleep 600"]
        } else {
            vec!["sh", "-c", "echo src; sleep 600"]
        }
    }
    #[cfg(windows)]
    {
        if marker == "the-source-history" {
            vec![
                "cmd",
                "/C",
                "echo the-source-history & ping -n 601 127.0.0.1 > nul",
            ]
        } else {
            vec!["cmd", "/C", "echo src & ping -n 601 127.0.0.1 > nul"]
        }
    }
}

#[cfg(windows)]
const GEN_PS1: &str = concat!(
    "$p = $args[0]\n",
    "$s = Get-Content -LiteralPath $p -Raw\n",
    "$ok = $s.Contains('the-source-history') -and $s.Contains('<<<START>>>')\n",
    "[Console]::Out.Write(\"read-ok=$(if ($ok) { 0 } else { 1 })`n\")\n",
    "[Console]::Out.Write('<<<START>>>' + \"`n\")\n",
    "[Console]::Out.Write('## Summary' + \"`n\")\n",
    "[Console]::Out.Write('generated-handoff-body' + \"`n\")\n",
    "[Console]::Out.Write('<<<END>>>' + \"`n\")\n",
);

async fn expect_started(ws: &mut WsStream) -> u32 {
    loop {
        match next_control(ws).await {
            proto::ServerMsg::HandoffStarted { request, .. } => return request,
            proto::ServerMsg::Error { message, .. } => panic!("daemon error: {message}"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn handoff_streams_chunks_and_persists_markdown() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_custom_msg(
        source_argv("the-source-history"),
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, source, "the-source-history").await;

    let prompt_ps1 = project.path().join("gen.ps1");
    #[cfg(unix)]
    let _ = &prompt_ps1;
    #[cfg(windows)]
    std::fs::write(&prompt_ps1, GEN_PS1).unwrap();
    #[cfg(unix)]
    let gen: Vec<&str> = vec![
        "sh",
        "-c",
        r#"grep -q "the-source-history" "$1" && grep -q "<<<START>>>" "$1"; echo "read-ok=$?"; printf '<<<START>>>\n## Summary\ngenerated-handoff-body\n<<<END>>>\n'"#,
        "sh",
    ];
    #[cfg(windows)]
    let gen: Vec<&str> = vec![
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        prompt_ps1.to_str().unwrap(),
    ];
    generate(&mut ws, source, gen).await;
    let request = expect_started(&mut ws).await;

    let mut chunks = String::new();
    let (markdown, saved_path) = loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffChunk { request: r, text } if r == request => {
                chunks.push_str(&text);
            }
            proto::ServerMsg::HandoffDone {
                request: r,
                markdown,
                saved_path,
            } if r == request => break (markdown, saved_path),
            proto::ServerMsg::HandoffError { message, .. } => {
                panic!("handoff failed: {message}")
            }
            _ => continue,
        }
    };

    assert!(
        chunks.contains("read-ok=0"),
        "generator saw the prompt (source history + template markers): {chunks:?}"
    );
    assert_eq!(markdown, "## Summary\ngenerated-handoff-body");
    let saved_norm = saved_path.replace('\\', "/");
    assert!(
        saved_norm.contains(".houston/handoffs/"),
        "persisted under .houston/handoffs: {saved_path}"
    );
    assert_eq!(std::fs::read_to_string(&saved_path).unwrap(), markdown);

    let leftovers: Vec<_> = std::fs::read_dir(project.path().join(".houston"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("handoff-prompt-")
        })
        .collect();
    assert!(leftovers.is_empty(), "prompt file must be deleted");

    let list = serde_json::to_string(&proto::ClientMsg::SessionList).unwrap();
    ws.send(Message::text(list)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::SessionList { sessions } => {
                assert_eq!(
                    sessions.iter().filter(|s| s.id != source).count(),
                    0,
                    "hidden sessions must not be listed: {sessions:?}"
                );
                break;
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn failed_generator_reports_an_error_naming_it() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_custom_msg(
        source_argv("src"),
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, source, "src").await;

    #[cfg(unix)]
    let gen: Vec<&str> = vec!["sh", "-c", "echo boom-details >&2; exit 3", "sh"];
    #[cfg(windows)]
    let gen: Vec<&str> = vec!["cmd", "/C", "echo boom-details 1>&2 & exit 3"];
    generate(&mut ws, source, gen).await;
    let request = expect_started(&mut ws).await;
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffError {
                request: r,
                message,
            } if r == request => {
                assert!(message.contains("custom"), "names the provider: {message}");
                assert!(
                    message.contains("boom-details"),
                    "carries output: {message}"
                );
                break;
            }
            proto::ServerMsg::HandoffDone { .. } => panic!("must not succeed"),
            _ => continue,
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cancel_delivers_sigint_before_the_kill() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_custom_msg(
        vec!["sh", "-c", "echo src; sleep 600"],
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, source, "src").await;

    let marker = project.path().join("got-sigint");
    let script = format!(
        "trap 'touch {}; exit 0' INT; echo started; sleep 600 & wait",
        marker.display()
    );
    generate(&mut ws, source, vec!["sh", "-c", &script, "sh"]).await;
    let request = expect_started(&mut ws).await;

    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffChunk { request: r, text }
                if r == request && text.contains("started") =>
            {
                break
            }
            _ => continue,
        }
    }

    let cancel = serde_json::to_string(&proto::ClientMsg::HandoffCancel { request }).unwrap();
    ws.send(Message::text(cancel)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffError {
                request: r,
                message,
            } if r == request => {
                assert!(message.contains("canceled"), "got: {message}");
                break;
            }
            proto::ServerMsg::HandoffDone { .. } => panic!("must not succeed"),
            _ => continue,
        }
    }
    assert!(
        marker.exists(),
        "generator must receive SIGINT (trap ran) before any hard kill"
    );
}

#[tokio::test]
async fn cancel_kills_the_generator() {
    let (addr, _state) = start_daemon().await;
    let project = tempfile::tempdir().unwrap();
    let mut ws = connect_and_hello(addr, TOKEN).await;
    let _ = next_control(&mut ws).await;

    ws.send(Message::text(create_custom_msg(
        source_argv("src"),
        project.path(),
    )))
    .await
    .unwrap();
    let source = expect_created(&mut ws).await.id;
    attach_and_collect_output_until(&mut ws, source, "src").await;

    #[cfg(unix)]
    let gen: Vec<&str> = vec!["sh", "-c", "echo started; sleep 600", "sh"];
    #[cfg(windows)]
    let gen: Vec<&str> = vec!["cmd", "/C", "echo started & ping -n 601 127.0.0.1 > nul"];
    generate(&mut ws, source, gen).await;
    let request = expect_started(&mut ws).await;

    let cancel = serde_json::to_string(&proto::ClientMsg::HandoffCancel { request }).unwrap();
    ws.send(Message::text(cancel)).await.unwrap();
    loop {
        match next_control(&mut ws).await {
            proto::ServerMsg::HandoffError {
                request: r,
                message,
            } if r == request => {
                assert!(message.contains("canceled"), "got: {message}");
                break;
            }
            proto::ServerMsg::HandoffDone { .. } => panic!("must not succeed"),
            _ => continue,
        }
    }
}
