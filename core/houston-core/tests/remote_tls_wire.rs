#![cfg(unix)]
//! The remote listener's two transports: plain HTTP on loopback for a proxy that
//! terminates HTTPS (the Tailscale route), and its own HTTPS with the local
//! certificate authority when devices reach it directly on a private address.

mod common;

use common::start_daemon_with_handle;
use houston_core::daemon::Daemon;
use houston_core::remote::tls::Authority;
use houston_core::remote::ConfigPatch;
use houston_protocol as proto;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_rustls::rustls;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn wait_listening(daemon: &Daemon) -> SocketAddr {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let state = daemon.remote_listen_state();
        if let Some(addr) = state.listening {
            return SocketAddr::from(([127, 0, 0, 1], addr.port()));
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "remote listener never came up: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn remote_daemon(
    bind: &str,
    public_url: Option<String>,
) -> (Arc<Daemon>, SocketAddr, tempfile::TempDir) {
    let (_addr, state, daemon) = start_daemon_with_handle().await;
    tokio::spawn(daemon.clone().remote_loops());
    daemon
        .remote_configure(ConfigPatch {
            enabled: Some(true),
            bind: Some(bind.to_string()),
            public_url,
            ..Default::default()
        })
        .unwrap();
    let addr = wait_listening(&daemon).await;
    (daemon, addr, state)
}

/// The Same Wi-Fi route: every interface, behind a private public URL.
async fn wifi_daemon() -> (Arc<Daemon>, SocketAddr, tempfile::TempDir) {
    let port = free_port();
    remote_daemon(
        &format!("0.0.0.0:{port}"),
        Some(format!("https://192.168.1.20:{port}")),
    )
    .await
}

fn client_config(ca_der: &[u8]) -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(ca_der.to_vec()))
        .unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

async fn tls_connect(
    addr: SocketAddr,
    ca_der: &[u8],
    name: rustls::pki_types::ServerName<'static>,
) -> std::io::Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    tokio_rustls::TlsConnector::from(client_config(ca_der))
        .connect(name, tcp)
        .await
}

fn ip_name(addr: SocketAddr) -> rustls::pki_types::ServerName<'static> {
    rustls::pki_types::ServerName::IpAddress(addr.ip().into())
}

/// Everything until the peer closes; a close without TLS close_notify ends the read too.
async fn read_all(stream: &mut (impl AsyncRead + Unpin)) -> Vec<u8> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
            Err(_) => panic!("no complete response within 10 s"),
            Ok(Ok(0)) => return raw,
            Ok(Ok(n)) => raw.extend_from_slice(&buf[..n]),
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return raw,
            Ok(Err(e)) => panic!("reading the response: {e}"),
        }
    }
}

/// One HTTP/1.1 exchange on `stream`: the status, the lowercased head and the body.
async fn exchange(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> (u16, String, Vec<u8>) {
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(body) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(body.unwrap_or(""));
    stream.write_all(req.as_bytes()).await.unwrap();
    let raw = read_all(&mut stream).await;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a complete response");
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head, raw[split + 4..].to_vec())
}

fn remote_info(daemon: &Daemon) -> proto::RemoteInfo {
    let proto::ServerMsg::RemoteState { remote } = daemon.remote_state_msg() else {
        panic!("expected remote_state");
    };
    remote
}

#[tokio::test]
async fn the_tailscale_route_keeps_plain_http_on_loopback_for_tailscale_serve() {
    let port = free_port();
    let (daemon, addr, _state) = remote_daemon(
        &format!("127.0.0.1:{port}"),
        Some("https://box.tail1.ts.net".into()),
    )
    .await;
    let info = remote_info(&daemon);
    assert!(!info.tls, "tailscale serve terminates HTTPS in front of it");
    assert_eq!(info.url, "https://box.tail1.ts.net");

    // tailscale serve forwards plain HTTP to the loopback port with the tailnet Host.
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (status, head, body) =
        exchange(tcp, "GET", "/", &[("Host", "box.tail1.ts.net")], None).await;
    assert_eq!(status, 200, "{head}");
    assert!(String::from_utf8_lossy(&body).contains("<html"));

    let code = daemon.remote_pair_start().code;
    let pair = serde_json::json!({ "code": code, "device_name": "Phone" }).to_string();
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (status, head, body) = exchange(
        tcp,
        "POST",
        "/api/pair",
        &[
            ("Host", "box.tail1.ts.net"),
            ("Origin", "https://box.tail1.ts.net"),
        ],
        Some(&pair),
    )
    .await;
    assert_eq!(status, 200, "{head}\n{}", String::from_utf8_lossy(&body));

    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (status, _, _) = exchange(
        tcp,
        "GET",
        "/houston-ca.crt",
        &[("Host", "box.tail1.ts.net")],
        None,
    )
    .await;
    assert_eq!(
        status, 404,
        "no certificate to trust behind tailscale serve"
    );
    assert_eq!(info.ca_fingerprint, None, "no authority was created");

    let stranger = Authority::generate("other").unwrap();
    assert!(
        tls_connect(addr, stranger.cert_der(), ip_name(addr))
            .await
            .is_err(),
        "the loopback listener speaks no TLS of its own"
    );
}

#[tokio::test]
async fn the_wifi_route_serves_https_with_the_local_authority_only() {
    let (daemon, addr, _state) = wifi_daemon().await;
    let ca = daemon.remote_authority().unwrap();
    let info = remote_info(&daemon);
    assert!(info.tls);
    assert_eq!(info.url, format!("https://192.168.1.20:{}", addr.port()));
    assert_eq!(
        info.ca_fingerprint.as_deref(),
        Some(ca.fingerprint().as_str())
    );

    let stream = tls_connect(addr, ca.cert_der(), ip_name(addr))
        .await
        .unwrap();
    let (status, head, _) =
        exchange(stream, "GET", "/", &[("Host", &addr.to_string())], None).await;
    assert_eq!(status, 200, "{head}");

    let stranger = Authority::generate("other").unwrap();
    assert!(
        tls_connect(addr, stranger.cert_der(), ip_name(addr))
            .await
            .is_err(),
        "a client that trusts another authority refuses the listener"
    );

    let mut plain = tokio::net::TcpStream::connect(addr).await.unwrap();
    plain
        .write_all(
            format!("GET / HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut answer = Vec::new();
    let mut buf = [0u8; 1024];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    // The handshake fails, so the listener ends the connection: EOF or a reset.
    while let Ok(Ok(n @ 1..)) = tokio::time::timeout_at(deadline, plain.read(&mut buf)).await {
        answer.extend_from_slice(&buf[..n]);
    }
    assert!(
        !String::from_utf8_lossy(&answer).contains("Houston"),
        "plain HTTP is not served on a private route"
    );

    // The public name is certified too, so the address in the QR code verifies.
    let name = rustls::pki_types::ServerName::try_from("192.168.1.20").unwrap();
    assert!(tls_connect(addr, ca.cert_der(), name).await.is_ok());

    let code = daemon.remote_pair_start().code;
    let pair = serde_json::json!({ "code": code, "device_name": "Phone" }).to_string();
    let stream = tls_connect(addr, ca.cert_der(), ip_name(addr))
        .await
        .unwrap();
    let origin = format!("https://192.168.1.20:{}", addr.port());
    let (status, head, body) = exchange(
        stream,
        "POST",
        "/api/pair",
        &[("Host", &addr.to_string()), ("Origin", &origin)],
        Some(&pair),
    )
    .await;
    assert_eq!(status, 200, "{head}\n{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn a_device_downloads_the_authority_before_pairing() {
    let (daemon, addr, _state) = wifi_daemon().await;
    let ca = daemon.remote_authority().unwrap();
    let host = addr.to_string();
    let get = |path: &'static str| {
        let (ca, host) = (ca.cert_der().to_vec(), host.clone());
        async move {
            let stream = tls_connect(addr, &ca, ip_name(addr)).await.unwrap();
            exchange(stream, "GET", path, &[("Host", &host)], None).await
        }
    };

    let (status, head, body) = get("/houston-ca.crt").await;
    assert_eq!(status, 200, "{head}");
    assert!(
        head.contains("content-type: application/x-x509-ca-cert"),
        "{head}"
    );
    assert_eq!(body, ca.cert_der(), "the download is the authority, as DER");

    let (_, head, body) = get("/houston-ca.mobileconfig").await;
    assert!(
        head.contains("content-type: application/x-apple-aspen-config"),
        "{head}"
    );
    let profile = String::from_utf8(body).unwrap();
    use base64::Engine as _;
    assert!(profile.contains(&base64::engine::general_purpose::STANDARD.encode(ca.cert_der())));
    assert!(profile.contains("com.apple.security.root"));

    let (status, _, body) = get("/api/ca").await;
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["fingerprint"], ca.fingerprint());
}

#[tokio::test]
async fn regenerating_the_authority_reissues_the_certificate_without_a_restart() {
    let (daemon, addr, _state) = wifi_daemon().await;
    let old = daemon.remote_authority().unwrap();
    daemon.remote_regenerate_authority().unwrap();
    let new = daemon.remote_authority().unwrap();
    assert_ne!(old.fingerprint(), new.fingerprint());
    assert_eq!(
        remote_info(&daemon).ca_fingerprint.as_deref(),
        Some(new.fingerprint().as_str())
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tls_connect(addr, new.cert_der(), ip_name(addr))
        .await
        .is_err()
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the listener never presented a certificate from the new authority"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        tls_connect(addr, old.cert_der(), ip_name(addr))
            .await
            .is_err(),
        "a device that trusts only the old authority is refused"
    );
    assert_eq!(
        daemon.remote_listen_state().listening.map(|a| a.port()),
        Some(addr.port())
    );
}

#[tokio::test]
async fn a_private_route_refuses_a_public_url_its_https_cannot_serve() {
    let (daemon, addr, _state) = wifi_daemon().await;
    let err = daemon
        .remote_configure(ConfigPatch {
            public_url: Some(format!("http://192.168.1.20:{}", addr.port())),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
    assert!(
        err.contains(&format!("use https://192.168.1.20:{}", addr.port())),
        "{err}"
    );
    assert_eq!(
        remote_info(&daemon).url,
        format!("https://192.168.1.20:{}", addr.port()),
        "a refusal changes nothing"
    );
}

#[tokio::test]
async fn switching_to_the_tailscale_route_restarts_the_listener_without_tls() {
    let (daemon, _addr, _state) = wifi_daemon().await;
    let port = free_port();
    daemon
        .remote_configure(ConfigPatch {
            bind: Some(format!("127.0.0.1:{port}")),
            public_url: Some("https://box.tail1.ts.net".into()),
            ..Default::default()
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while daemon.remote_listen_state().listening.map(|a| a.port()) != Some(port) {
        assert!(tokio::time::Instant::now() < deadline, "no new listener");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let info = remote_info(&daemon);
    assert!(!info.tls);
    assert!(
        info.ca_fingerprint.is_some(),
        "the authority stays, so a device that trusts it keeps working on the way back"
    );
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let (status, head, _) = exchange(tcp, "GET", "/", &[("Host", "box.tail1.ts.net")], None).await;
    assert_eq!(status, 200, "{head}");
}
