//! Provider sign-in callbacks. Upstream's Electron main receives the OAuth redirect on a
//! loopback HTTP listener named by the authorization URL, so the Tauri host does the same:
//! bind 127.0.0.1:<port>, open the browser, and hand the validated redirect back.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use url::Url;

const INVALID_REQUEST: &str = "Invalid ChatGPT sign-in request.";
const ALREADY_OPEN: &str = "This sign-in is already open on this computer.";
const PORT_IN_USE: &str = "The ChatGPT callback port is in use on this computer. Close the \
                           other sign-in and try again, or paste the redirect URL in Houston.";
const BROWSER_FAILED: &str = "Could not open your sign-in browser.";
const CANCELLED: &str = "Sign-in cancelled on this computer.";
const EXPIRED: &str = "Sign-in expired. Try again.";

const MAX_AUTHORIZATION_URL_LEN: usize = 16_384;
const MAX_CALLBACK_URL_LEN: usize = 16_384;
const MAX_REQUEST_BYTES: usize = 16_384;

/// A browser sends its request line immediately; a stalled connection must not pin the
/// sign-in for the rest of the callback window.
const REQUEST_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Matches the Electron helper's own callback window before it reports an expired sign-in.
const CALLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

const CALLBACK_PAGE: &str = "<!doctype html><html><head><meta name=\"viewport\" \
content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light \
dark\"><title>Houston</title><style>body{font-family:system-ui;display:grid;\
place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}\
h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>Return to \
Houston</h1><p>Your sign-in response has been received. Houston is finishing the connection. \
You can close this tab.</p></main></body></html>";

const BAD_CALLBACK: &str = "This response does not belong to the active sign-in.";

#[derive(Debug, PartialEq, Eq)]
struct AuthRequest {
    authorization_url: String,
    state: String,
    port: u16,
}

fn redirect_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^http://127\.0\.0\.1:[1-9][0-9]{0,4}/auth/callback$")
            .expect("redirect pattern compiles")
    })
}

fn state_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]{16,128}$").expect("state pattern compiles"))
}

fn challenge_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[A-Za-z0-9_-]{43}$").expect("challenge pattern compiles"))
}

fn client_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^(dynamic_agent_client|oaiapp_[A-Za-z0-9_-]+)$")
            .expect("client pattern compiles")
    })
}

fn callback_client_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^oaiapp_[A-Za-z0-9_-]+$").expect("callback client pattern compiles")
    })
}

fn single<'a>(pairs: &'a [(String, String)], key: &str) -> Result<&'a str, ()> {
    let mut matching = pairs.iter().filter(|(name, _)| name == key);
    let first = matching.next().ok_or(())?;
    if matching.next().is_some() || first.1.is_empty() {
        return Err(());
    }
    Ok(&first.1)
}

fn is_openai_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("auth.openai.com")
        && url.port_or_known_default() == Some(443)
}

/// Mirrors the Electron helper's `codexAuthorizationRequest` checks so the host refuses
/// anything the server would not have produced.
fn parse_authorization_request(value: &str) -> Result<AuthRequest, ()> {
    if value.len() > MAX_AUTHORIZATION_URL_LEN {
        return Err(());
    }
    let url = Url::parse(value).map_err(|_| ())?;
    if !is_openai_origin(&url)
        || url.path() != "/api/accounts/authorize"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return Err(());
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    let redirect_uri = single(&pairs, "redirect_uri")?;
    if !redirect_pattern().is_match(redirect_uri) {
        return Err(());
    }
    let redirect = Url::parse(redirect_uri).map_err(|_| ())?;
    let port = redirect.port_or_known_default().ok_or(())?;
    let state = single(&pairs, "state")?;
    if !state_pattern().is_match(state)
        || single(&pairs, "response_type")? != "code"
        || single(&pairs, "code_challenge_method")? != "S256"
        || !challenge_pattern().is_match(single(&pairs, "code_challenge")?)
        || !client_pattern().is_match(single(&pairs, "client_id")?)
    {
        return Err(());
    }
    Ok(AuthRequest {
        authorization_url: url.to_string(),
        state: state.to_string(),
        port,
    })
}

/// Mirrors the Electron helper's `codexCallbackUrl` checks; a rejected request leaves the
/// listener waiting for the real redirect.
fn callback_url(target: &str, request: &AuthRequest) -> Result<String, ()> {
    let base = format!("http://127.0.0.1:{}/", request.port);
    let url = Url::parse(&base)
        .map_err(|_| ())?
        .join(target)
        .map_err(|_| ())?;
    if url.as_str().len() > MAX_CALLBACK_URL_LEN
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default() != Some(request.port)
        || url.path() != "/auth/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    let states: Vec<&str> = pairs
        .iter()
        .filter(|(name, _)| name == "state")
        .map(|(_, value)| value.as_str())
        .collect();
    if states != [request.state.as_str()] {
        return Err(());
    }
    let clients: Vec<&str> = pairs
        .iter()
        .filter(|(name, _)| name == "client_id")
        .map(|(_, value)| value.as_str())
        .collect();
    if clients.len() > 1
        || clients
            .first()
            .is_some_and(|id| !callback_client_pattern().is_match(id))
    {
        return Err(());
    }
    let values = |key: &str| -> Vec<&str> {
        pairs
            .iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
            .collect()
    };
    let codes = values("code");
    let errors = values("error");
    let one = |items: &[&str]| items.len() == 1 && !items[0].is_empty();
    if !((one(&codes) && errors.is_empty()) || (one(&errors) && codes.is_empty())) {
        return Err(());
    }
    Ok(url.to_string())
}

#[derive(Default)]
pub struct ProviderAuthCallbacks {
    listeners: Mutex<HashMap<String, watch::Sender<()>>>,
}

impl ProviderAuthCallbacks {
    fn register(&self, state: &str) -> Result<watch::Receiver<()>, String> {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if listeners.contains_key(state) {
            return Err(ALREADY_OPEN.to_string());
        }
        let (sender, receiver) = watch::channel(());
        listeners.insert(state.to_string(), sender);
        Ok(receiver)
    }

    fn cancel(&self, state: &str) {
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(sender) = listeners.get(state) {
            let _ = sender.send(());
        }
    }
}

struct Registration<'a> {
    callbacks: &'a ProviderAuthCallbacks,
    state: String,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.callbacks
            .listeners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&self.state);
    }
}

async fn read_request_target(socket: &mut TcpStream) -> Result<String, ()> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        let header_end = buffer.windows(4).any(|window| window == b"\r\n\r\n");
        if header_end {
            break;
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            return Err(());
        }
        let read = socket.read(&mut chunk).await.map_err(|_| ())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    if buffer.len() > MAX_REQUEST_BYTES {
        return Err(());
    }
    let head = std::str::from_utf8(&buffer).map_err(|_| ())?;
    let line = head.split("\r\n").next().ok_or(())?;
    let mut parts = line.split(' ');
    let method = parts.next().ok_or(())?;
    let target = parts.next().ok_or(())?;
    if method != "GET" || !target.starts_with('/') {
        return Err(());
    }
    Ok(target.to_string())
}

async fn write_response(
    socket: &mut TcpStream,
    status: &str,
    headers: &[(&str, &str)],
    body: &str,
) {
    let mut response = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    ));
    response.push_str(body);
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.flush().await;
    let _ = socket.shutdown().await;
}

async fn write_callback_received(socket: &mut TcpStream) {
    write_response(
        socket,
        "200 OK",
        &[
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
            (
                "content-security-policy",
                "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
            ),
            ("content-type", "text/html; charset=utf-8"),
        ],
        CALLBACK_PAGE,
    )
    .await;
}

async fn write_bad_request(socket: &mut TcpStream) {
    write_response(
        socket,
        "400 Bad Request",
        &[
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
            ("content-type", "text/plain; charset=utf-8"),
        ],
        BAD_CALLBACK,
    )
    .await;
}

async fn wait_for_callback(
    listener: TcpListener,
    request: &AuthRequest,
    mut cancel: watch::Receiver<()>,
) -> Result<String, String> {
    let timeout = tokio::time::sleep(CALLBACK_TIMEOUT);
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            _ = cancel.changed() => return Err(CANCELLED.to_string()),
            _ = &mut timeout => return Err(EXPIRED.to_string()),
            accepted = listener.accept() => {
                let (mut socket, _) = accepted.map_err(|error| {
                    format!("Could not receive the sign-in callback: {error}")
                })?;
                let target = tokio::time::timeout(REQUEST_READ_TIMEOUT, read_request_target(&mut socket))
                    .await
                    .unwrap_or(Err(()));
                match target.and_then(|target| callback_url(&target, request)) {
                    Ok(url) => {
                        write_callback_received(&mut socket).await;
                        return Ok(url);
                    }
                    Err(()) => write_bad_request(&mut socket).await,
                }
            }
        }
    }
}

async fn receive_provider_auth_callback<F, Fut>(
    callbacks: &ProviderAuthCallbacks,
    authorization_url: &str,
    open_browser: F,
) -> Result<String, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let request =
        parse_authorization_request(authorization_url).map_err(|()| INVALID_REQUEST.to_string())?;
    let cancel = callbacks.register(&request.state)?;
    let _registration = Registration {
        callbacks,
        state: request.state.clone(),
    };
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, request.port))
        .await
        .map_err(|_| PORT_IN_USE.to_string())?;
    open_browser(request.authorization_url.clone())
        .await
        .map_err(|_| BROWSER_FAILED.to_string())?;
    wait_for_callback(listener, &request, cancel).await
}

fn cancel_provider_auth_callback(
    callbacks: &ProviderAuthCallbacks,
    authorization_url: &str,
) -> Result<(), String> {
    let request =
        parse_authorization_request(authorization_url).map_err(|()| INVALID_REQUEST.to_string())?;
    callbacks.cancel(&request.state);
    Ok(())
}

#[tauri::command]
pub async fn provider_auth_receive(
    app: tauri::AppHandle,
    callbacks: tauri::State<'_, ProviderAuthCallbacks>,
    authorization_url: String,
) -> Result<String, String> {
    let callback = receive_provider_auth_callback(&callbacks, &authorization_url, |url| async {
        crate::shell::shell_open_external(url).await
    })
    .await?;
    crate::tray::show_main_window(&app);
    Ok(callback)
}

#[tauri::command]
pub fn provider_auth_cancel(
    callbacks: tauri::State<'_, ProviderAuthCallbacks>,
    authorization_url: String,
) -> Result<(), String> {
    cancel_provider_auth_callback(&callbacks, &authorization_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "abcdefghijklmnopqrstuvwxyz012345";

    fn authorization_url(port: u16, state: &str) -> String {
        let challenge = "a".repeat(43);
        format!(
            "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client\
&response_type=code&redirect_uri=http://127.0.0.1:{port}/auth/callback&state={state}\
&code_challenge_method=S256&code_challenge={challenge}"
        )
    }

    fn change(value: &str, from: &str, to: &str) -> String {
        value.replace(from, to)
    }

    #[test]
    fn authorization_requests_require_the_openai_authorize_endpoint() {
        let valid = authorization_url(49_152, STATE);
        let request = parse_authorization_request(&valid).unwrap();
        assert_eq!(request.port, 49_152);
        assert_eq!(request.state, STATE);

        let invalid = [
            authorization_url(49_152, STATE).replace("https://", "http://"),
            change(&valid, "auth.openai.com", "auth.example.com"),
            change(&valid, "/api/accounts/authorize", "/api/accounts/other"),
            change(&valid, "response_type=code", "response_type=token"),
            change(
                &valid,
                "code_challenge_method=S256",
                "code_challenge_method=plain",
            ),
            change(
                &valid,
                "redirect_uri=http://127.0.0.1",
                "redirect_uri=http://127.0.0.2",
            ),
            change(&valid, "redirect_uri=http://", "redirect_uri=https://"),
            change(
                &valid,
                "state=abcdefghijklmnopqrstuvwxyz012345",
                "state=short",
            ),
            change(&valid, "&state=", "&state=again&state="),
            change(
                &valid,
                "client_id=dynamic_agent_client",
                "client_id=someone_else",
            ),
            change(&valid, &"a".repeat(43), "too-short"),
            format!("{valid}&state={STATE}"),
            format!("{valid}#fragment"),
            "x".repeat(MAX_AUTHORIZATION_URL_LEN + 1),
        ];
        for value in invalid {
            assert!(
                parse_authorization_request(&value).is_err(),
                "accepted {value:?}"
            );
        }
        assert!(parse_authorization_request(&format!("{valid}#")).is_ok());
    }

    #[test]
    fn callbacks_must_match_the_active_sign_in() {
        let request = parse_authorization_request(&authorization_url(49_152, STATE)).unwrap();
        let callback = |query: &str| callback_url(&format!("/auth/callback?{query}"), &request);

        let code = callback(&format!("code=the-code&state={STATE}")).unwrap();
        assert_eq!(
            code,
            format!("http://127.0.0.1:49152/auth/callback?code=the-code&state={STATE}")
        );
        assert!(callback(&format!("error=access_denied&state={STATE}")).is_ok());
        assert!(callback(&format!(
            "code=the-code&state={STATE}&client_id=oaiapp_abc-123"
        ))
        .is_ok());
        assert!(callback(&format!("code=a+b%2Bc&state={STATE}"))
            .unwrap()
            .contains("code=a+b%2Bc"));

        for query in [
            "code=the-code".to_string(),
            "code=the-code&state=anotherstatevalue12".to_string(),
            format!("state={STATE}"),
            format!("code=the-code&error=denied&state={STATE}"),
            format!("code=&state={STATE}"),
            format!("code=the-code&state={STATE}&state={STATE}"),
            format!("code=the-code&state={STATE}&client_id=other"),
            format!("code=the-code&state={STATE}&client_id=oaiapp_a&client_id=oaiapp_b"),
        ] {
            assert!(callback(&query).is_err(), "accepted {query:?}");
        }
        assert!(callback_url(&format!("/other?code=x&state={STATE}"), &request).is_err());
        assert!(callback_url(
            &format!("/auth/callback?code=x&state={STATE}#frag"),
            &request
        )
        .is_err());
    }

    #[tokio::test]
    async fn cancel_reaches_the_registered_listener() {
        let callbacks = ProviderAuthCallbacks::default();
        let url = authorization_url(49_152, STATE);
        let mut cancel = callbacks.register(STATE).unwrap();
        assert_eq!(
            callbacks.register(STATE).unwrap_err(),
            "This sign-in is already open on this computer."
        );
        cancel_provider_auth_callback(&callbacks, &url).unwrap();
        assert!(cancel.changed().await.is_ok());
        assert!(cancel_provider_auth_callback(&callbacks, "not a url").is_err());
    }

    async fn bind_test_listener(port: u16) -> TcpListener {
        TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap()
    }

    async fn get(port: u16, target: &str) -> String {
        let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn the_listener_returns_the_callback_url_and_answers_the_browser() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let request = parse_authorization_request(&authorization_url(port, STATE)).unwrap();
        let (sender, receiver) = watch::channel(());
        let target = format!("/auth/callback?code=the-code&state={STATE}");
        let expected = format!("http://127.0.0.1:{port}{target}");
        let round = tokio::spawn(async move {
            let result = wait_for_callback(listener, &request, receiver).await;
            drop(sender);
            result
        });
        let response = get(port, &target).await;
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("Return to Houston"), "{response}");
        assert_eq!(round.await.unwrap().unwrap(), expected);
    }

    #[tokio::test]
    async fn a_bad_request_is_reported_and_the_listener_keeps_waiting() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let request = parse_authorization_request(&authorization_url(port, STATE)).unwrap();
        let (_sender, receiver) = watch::channel(());
        let round =
            tokio::spawn(async move { wait_for_callback(listener, &request, receiver).await });
        let rejected = get(port, "/auth/callback?code=x&state=wrongstatevalue12").await;
        assert!(rejected.starts_with("HTTP/1.1 400"), "{rejected}");
        assert!(rejected.contains(BAD_CALLBACK), "{rejected}");
        let accepted = get(port, &format!("/auth/callback?code=the-code&state={STATE}")).await;
        assert!(accepted.starts_with("HTTP/1.1 200"), "{accepted}");
        assert!(round.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn a_cancelled_sign_in_stops_the_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let request = parse_authorization_request(&authorization_url(port, STATE)).unwrap();
        let callbacks = ProviderAuthCallbacks::default();
        let url = authorization_url(port, STATE);
        let receiver = callbacks.register(STATE).unwrap();
        let round =
            tokio::spawn(async move { wait_for_callback(listener, &request, receiver).await });
        cancel_provider_auth_callback(&callbacks, &url).unwrap();
        assert_eq!(round.await.unwrap().unwrap_err(), CANCELLED);
    }

    #[tokio::test]
    async fn a_listener_that_cannot_open_a_browser_reports_it() {
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let callbacks = ProviderAuthCallbacks::default();
        let error = receive_provider_auth_callback(
            &callbacks,
            &authorization_url(port, STATE),
            |_| async { Err("no browser".to_string()) },
        )
        .await
        .unwrap_err();
        assert_eq!(error, BROWSER_FAILED);
    }

    #[tokio::test]
    async fn the_registration_is_released_when_the_sign_in_ends() {
        let port = {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let callbacks = ProviderAuthCallbacks::default();
        let url = authorization_url(port, STATE);
        receive_provider_auth_callback(&callbacks, &url, |_| async {
            Err("no browser".to_string())
        })
        .await
        .unwrap_err();
        assert!(callbacks.register(STATE).is_ok());
    }

    #[tokio::test]
    async fn an_unused_port_is_reported_as_in_use() {
        let listener = bind_test_listener(0).await;
        let port = listener.local_addr().unwrap().port();
        let callbacks = ProviderAuthCallbacks::default();
        let error = receive_provider_auth_callback(
            &callbacks,
            &authorization_url(port, STATE),
            |_| async { Ok(()) },
        )
        .await
        .unwrap_err();
        assert_eq!(error, PORT_IN_USE);
    }
}
