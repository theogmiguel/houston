//! A Windows loopback port per WSL environment. Each accepted connection gets its own
//! upstream (`houston-core wsl-proxy` through `wsl.exe`), so WSL needs no networking mode.

use super::command::Piped;
use futures_util::future::BoxFuture;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio::time::Instant;

/// Spacing between `wsl-ensure` attempts after an upstream closed.
pub const RETRY_DELAY: Duration = Duration::from_millis(1000);

pub trait Backend: Send + Sync + 'static {
    fn connect(&self) -> io::Result<Piped>;
    /// Re-runs `wsl-ensure` and records what it reports.
    fn ensure(&self) -> BoxFuture<'static, Result<(), String>>;
}

struct Shared {
    backend: Arc<dyn Backend>,
    retry_delay: Duration,
    needs_ensure: AtomicBool,
    closing: AtomicBool,
    last_attempt: tokio::sync::Mutex<Option<Instant>>,
}

pub struct Relay {
    addr: SocketAddr,
    shared: Arc<Shared>,
    task: tokio::task::JoinHandle<()>,
}

impl Relay {
    pub async fn start(backend: Arc<dyn Backend>, retry_delay: Duration) -> io::Result<Relay> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            backend,
            retry_delay,
            needs_ensure: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            last_attempt: tokio::sync::Mutex::new(None),
        });
        let task = tokio::spawn(accept_loop(listener, Arc::clone(&shared)));
        Ok(Relay { addr, shared, task })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    #[cfg(test)]
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stops re-running `wsl-ensure`, so a daemon being shut down is not started again.
    pub fn close(&self) {
        self.shared.closing.store(true, Ordering::SeqCst);
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>) {
    let mut connections = JoinSet::new();
    loop {
        while connections.try_join_next().is_some() {}
        match listener.accept().await {
            Ok((client, _)) => {
                let _ = client.set_nodelay(true);
                connections.spawn(serve(client, Arc::clone(&shared)));
            }
            Err(e) => {
                eprintln!("houston-tauri: wsl relay: accept failed: {e}");
                tokio::time::sleep(shared.retry_delay).await;
            }
        }
    }
}

async fn ensure_gate(shared: &Shared) -> bool {
    let mut last = shared.last_attempt.lock().await;
    if !shared.needs_ensure.load(Ordering::SeqCst) {
        return true;
    }
    if shared.closing.load(Ordering::SeqCst) {
        return false;
    }
    if let Some(at) = *last {
        tokio::time::sleep_until(at + shared.retry_delay).await;
    }
    *last = Some(Instant::now());
    match shared.backend.ensure().await {
        Ok(()) => {
            shared.needs_ensure.store(false, Ordering::SeqCst);
            true
        }
        Err(e) => {
            eprintln!("houston-tauri: wsl relay: wsl-ensure failed: {e}");
            false
        }
    }
}

async fn serve(client: TcpStream, shared: Arc<Shared>) {
    if shared.needs_ensure.load(Ordering::SeqCst) && !ensure_gate(&shared).await {
        return;
    }
    let Piped {
        stdin: mut upstream_in,
        stdout: mut upstream_out,
        child,
    } = match shared.backend.connect() {
        Ok(piped) => piped,
        Err(e) => {
            eprintln!("houston-tauri: wsl relay: starting wsl-proxy failed: {e}");
            shared.needs_ensure.store(true, Ordering::SeqCst);
            return;
        }
    };
    let (mut client_in, mut client_out) = client.into_split();
    let client_closed = AtomicBool::new(false);
    let (up_done, mut up_done_rx) = tokio::sync::oneshot::channel::<()>();
    let to_client = async {
        let upstream_ended = tokio::io::copy(&mut upstream_out, &mut client_out)
            .await
            .is_ok();
        if upstream_ended && !client_closed.load(Ordering::SeqCst) {
            shared.needs_ensure.store(true, Ordering::SeqCst);
        }
        let _ = client_out.shutdown().await;
        let _ = up_done.send(());
    };
    let to_upstream = async {
        tokio::select! {
            _ = tokio::io::copy(&mut client_in, &mut upstream_in) => {
                client_closed.store(true, Ordering::SeqCst)
            }
            _ = &mut up_done_rx => {}
        }
        // Closing the child's stdin half-closes wsl-proxy's socket; it exits once the
        // daemon's reply has drained.
        let _ = upstream_in.shutdown().await;
        drop(upstream_in);
    };
    tokio::join!(to_client, to_upstream);
    if let Some(mut child) = child {
        let _ = child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, DuplexStream};

    struct Fake {
        connects: Mutex<Vec<Instant>>,
        ensures: Mutex<Vec<Instant>>,
        ensure_results: Mutex<Vec<Result<(), String>>>,
        daemons: tokio::sync::mpsc::UnboundedSender<DuplexStream>,
    }

    impl Backend for Fake {
        fn connect(&self) -> io::Result<Piped> {
            self.connects.lock().unwrap().push(Instant::now());
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            self.daemons.send(theirs).unwrap();
            let (read, write) = tokio::io::split(ours);
            Ok(Piped {
                stdin: Box::new(write),
                stdout: Box::new(read),
                child: None,
            })
        }

        fn ensure(&self) -> BoxFuture<'static, Result<(), String>> {
            self.ensures.lock().unwrap().push(Instant::now());
            let result = self.ensure_results.lock().unwrap().remove(0);
            Box::pin(async move { result })
        }
    }

    fn fake(
        ensure_results: Vec<Result<(), String>>,
    ) -> (
        Arc<Fake>,
        tokio::sync::mpsc::UnboundedReceiver<DuplexStream>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = Arc::new(Fake {
            connects: Mutex::new(Vec::new()),
            ensures: Mutex::new(Vec::new()),
            ensure_results: Mutex::new(ensure_results),
            daemons: tx,
        });
        (fake, rx)
    }

    async fn read_to_end(stream: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut buf))
            .await
            .expect("the relay closes the client")
            .unwrap();
        buf
    }

    #[tokio::test]
    async fn binds_loopback_only() {
        let (fake, _daemons) = fake(Vec::new());
        let relay = Relay::start(fake, RETRY_DELAY).await.unwrap();
        assert_eq!(relay.local_addr().ip(), Ipv4Addr::LOCALHOST);
        assert_ne!(relay.port(), 0);
    }

    #[tokio::test]
    async fn reconnect_reruns_ensure_every_second() {
        assert_eq!(RETRY_DELAY, Duration::from_millis(1000));
        let (fake, mut daemons) = fake(vec![Err("daemon still starting".into()), Ok(())]);
        let relay = Relay::start(fake.clone(), RETRY_DELAY).await.unwrap();
        let port = relay.port();

        // The first upstream closes at once, as wsl-proxy does when no daemon answers.
        let mut first = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        drop(daemons.recv().await.unwrap());
        assert!(read_to_end(&mut first).await.is_empty());
        let upstream_closed = Instant::now();
        assert!(fake.ensures.lock().unwrap().is_empty());

        // The next connection re-runs ensure first; this attempt fails, so no upstream.
        let mut second = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert!(read_to_end(&mut second).await.is_empty());
        assert_eq!(fake.ensures.lock().unwrap().len(), 1);
        assert_eq!(fake.connects.lock().unwrap().len(), 1);

        // The retry waits out the delay since the failed attempt, then connects.
        let mut third = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut daemon = daemons.recv().await.unwrap();
        third.write_all(b"ping").await.unwrap();
        let mut got = [0u8; 4];
        daemon.read_exact(&mut got).await.unwrap();
        daemon.write_all(b"pong").await.unwrap();
        third.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"pong");

        let ensures = fake.ensures.lock().unwrap().clone();
        let connects = fake.connects.lock().unwrap().clone();
        assert_eq!(ensures.len(), 2, "one ensure per attempt");
        assert!(ensures[0] >= upstream_closed);
        assert!(
            ensures[1] - ensures[0] >= RETRY_DELAY,
            "attempts {:?} apart",
            ensures[1] - ensures[0]
        );
        assert_eq!(connects.len(), 2);
        assert!(
            connects[1] >= ensures[1],
            "ensure runs before the next upstream"
        );
    }

    #[tokio::test]
    async fn a_client_close_is_not_an_upstream_failure() {
        let (fake, mut daemons) = fake(Vec::new());
        let relay = Relay::start(fake.clone(), RETRY_DELAY).await.unwrap();
        let client = TcpStream::connect(("127.0.0.1", relay.port()))
            .await
            .unwrap();
        let mut daemon = daemons.recv().await.unwrap();
        drop(client);
        let mut rest = Vec::new();
        daemon.read_to_end(&mut rest).await.unwrap();
        drop(daemon);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _next = TcpStream::connect(("127.0.0.1", relay.port()))
            .await
            .unwrap();
        let _daemon = daemons.recv().await.unwrap();
        assert!(fake.ensures.lock().unwrap().is_empty());
    }
}
