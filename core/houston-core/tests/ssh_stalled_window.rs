#![cfg(feature = "test-barriers")]
use russh::{server, Channel, ChannelId};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

struct Stalled {
    channel: Option<Channel<server::Msg>>,
    received: Arc<AtomicUsize>,
    changed: Arc<tokio::sync::Notify>,
}
impl server::Handler for Stalled {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channel = Some(channel);
        reply.accept().await;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"READY".to_vec())?;
        Ok(())
    }
    async fn data(
        &mut self,
        _: ChannelId,
        data: &[u8],
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.received.fetch_add(data.len(), Ordering::SeqCst);
        self.changed.notify_one();
        Ok(())
    }
    fn adjust_window(&mut self, _: ChannelId, _: u32) -> u32 {
        0
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_stalled_window_bounds_input_and_close_preempts_transfer() {
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let home = tempfile::tempdir().unwrap();
    let known = home.path().join("known_hosts");
    std::fs::write(
        &known,
        format!("fixture {}\n", key.public_key().to_openssh().unwrap()),
    )
    .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        window_size: 0,
        maximum_packet_size: 1024,
        ..Default::default()
    });
    let received = Arc::new(AtomicUsize::new(0));
    let changed = Arc::new(tokio::sync::Notify::new());
    let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(server::run_stream(
        config,
        server_stream,
        Stalled {
            channel: None,
            received: received.clone(),
            changed: changed.clone(),
        },
    ));
    let (handle, connected) = tokio::time::timeout(
        Duration::from_secs(15),
        houston_core::ssh::connect_stream_for_test(client_stream, known),
    )
    .await
    .unwrap()
    .unwrap();
    let server = server_task.await.unwrap().unwrap();
    let output = Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = output.clone();
    let driver = tokio::spawn(houston_core::ssh::run(connected, move |data| {
        capture.lock().unwrap().extend_from_slice(data)
    }));
    let active = handle.enqueue_stdin(&vec![b'a'; 256 * 1024]).unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while !handle.transfer_active_for_test() || output.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(active.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
        "writer must remain pending after the fixture advertises a zero receive window"
    );
    let queued = handle
        .enqueue_stdin(&vec![b'b'; 4 * 1024 * 1024 - 256 * 1024])
        .unwrap();
    let refusal = handle.enqueue_stdin(b"x").unwrap_err();
    assert_eq!(refusal.written, Some(0));
    assert!(refusal.to_string().contains("byte limit 4194304"));
    handle.resize(90, 30).unwrap();
    handle.resize(100, 40).unwrap();
    handle.kill().unwrap();
    tokio::time::timeout(Duration::from_secs(15), driver)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        active
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err()
            .written,
        None
    );
    assert_eq!(
        queued
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap_err()
            .written,
        Some(0)
    );
    assert_eq!(handle.enqueue_stdin(b"late").unwrap_err().written, Some(0));
    assert_eq!(
        received.load(Ordering::SeqCst),
        0,
        "fixture never restores its window"
    );
    assert_eq!(
        &*output.lock().unwrap(),
        b"READY",
        "output survives pending input"
    );
    let server_result = tokio::time::timeout(Duration::from_secs(15), server)
        .await
        .unwrap();
    assert!(
        server_result.is_ok()
            || matches!(&server_result, Err(russh::Error::IO(error)) if error.kind() == std::io::ErrorKind::BrokenPipe),
        "closing the client must release the server, got {server_result:?}"
    );
}
