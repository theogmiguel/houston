use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpScope {
    pub session_id: u32,
    pub workspace_id: String,
}

// long enough to survive a pane left idle overnight, short enough that a leaked
// token stops working within a day of its pane going quiet
pub const LIVENESS_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

const TOKEN_BYTES: usize = 32;

struct Record {
    scope: McpScope,
    last_alive: Instant,
}

#[derive(Default)]
struct State {
    // keyed by the token's own SHA-256, never the raw value, so a log line or a
    // state dump can't be replayed as a live credential
    by_hash: HashMap<String, Record>,
}

pub struct Registry {
    state: Mutex<State>,
    window: Duration,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Self::with_window(LIVENESS_WINDOW)
    }

    pub fn with_window(window: Duration) -> Self {
        Self {
            state: Mutex::new(State::default()),
            window,
        }
    }

    pub fn issue(&self, scope: McpScope) -> String {
        let raw = mint_token();
        let hash = hash_token(&raw);
        let mut state = self.state.lock().expect("mcp creds lock");
        let now = Instant::now();
        // a session holds exactly one live credential; reissuing (e.g. on daemon
        // restart) retires the old one so a leaked prior token stops working
        state
            .by_hash
            .retain(|_, r| r.scope.session_id != scope.session_id);
        prune(&mut state, now, self.window);
        state.by_hash.insert(
            hash,
            Record {
                scope,
                last_alive: now,
            },
        );
        raw
    }

    pub fn resolve(&self, raw: &str) -> Option<McpScope> {
        if raw.is_empty() {
            return None;
        }
        let hash = hash_token(raw);
        let mut state = self.state.lock().expect("mcp creds lock");
        let now = Instant::now();
        prune(&mut state, now, self.window);
        let record = state.by_hash.get_mut(&hash)?;
        record.last_alive = now;
        Some(record.scope.clone())
    }

    pub fn touch_session(&self, session_id: u32) {
        let mut state = self.state.lock().expect("mcp creds lock");
        let now = Instant::now();
        for record in state.by_hash.values_mut() {
            if record.scope.session_id == session_id {
                record.last_alive = now;
            }
        }
    }

    pub fn revoke_session(&self, session_id: u32) {
        let mut state = self.state.lock().expect("mcp creds lock");
        state
            .by_hash
            .retain(|_, r| r.scope.session_id != session_id);
    }

    pub fn len(&self) -> usize {
        let mut state = self.state.lock().expect("mcp creds lock");
        prune(&mut state, Instant::now(), self.window);
        state.by_hash.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn export_for_session(&self, session_id: u32) -> Option<(String, McpScope, Duration)> {
        let mut state = self.state.lock().expect("mcp creds lock");
        let now = Instant::now();
        prune(&mut state, now, self.window);
        state
            .by_hash
            .iter()
            .find(|(_, r)| r.scope.session_id == session_id)
            .map(|(hash, r)| {
                let remaining = self.window.saturating_sub(now.duration_since(r.last_alive));
                (hash.clone(), r.scope.clone(), remaining)
            })
    }

    pub fn import_hashed(&self, hash: String, scope: McpScope, remaining: Duration) {
        let mut state = self.state.lock().expect("mcp creds lock");
        let now = Instant::now();
        let last_alive = now
            .checked_sub(self.window.saturating_sub(remaining))
            .unwrap_or(now);
        state.by_hash.insert(hash, Record { scope, last_alive });
    }
}

fn prune(state: &mut State, now: Instant, window: Duration) {
    state
        .by_hash
        .retain(|_, r| now.duration_since(r.last_alive) <= window);
}

fn mint_token() -> String {
    use base64::Engine as _;
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(session_id: u32) -> McpScope {
        McpScope {
            session_id,
            workspace_id: format!("/home/dev/ws-{session_id}"),
        }
    }

    #[test]
    fn a_minted_token_resolves_to_its_own_scope() {
        let reg = Registry::new();
        let token = reg.issue(scope(7));
        assert_eq!(reg.resolve(&token), Some(scope(7)));
    }

    #[test]
    fn two_sessions_never_see_each_others_scope() {
        let reg = Registry::new();
        let a = reg.issue(scope(1));
        let b = reg.issue(scope(2));
        assert_eq!(reg.resolve(&a).unwrap().workspace_id, "/home/dev/ws-1");
        assert_eq!(reg.resolve(&b).unwrap().workspace_id, "/home/dev/ws-2");
    }

    #[test]
    fn an_unknown_or_empty_token_resolves_to_nothing() {
        let reg = Registry::new();
        reg.issue(scope(1));
        assert_eq!(reg.resolve("not-a-token"), None);
        assert_eq!(reg.resolve(""), None);
    }

    #[test]
    fn reissuing_revokes_the_sessions_previous_token() {
        let reg = Registry::new();
        let first = reg.issue(scope(3));
        let second = reg.issue(scope(3));
        assert_eq!(reg.resolve(&first), None, "the superseded token must die");
        assert!(reg.resolve(&second).is_some());
        assert_eq!(
            reg.len(),
            1,
            "a reissue must not leave two live credentials"
        );
    }

    #[test]
    fn revoking_one_session_leaves_the_others_alone() {
        let reg = Registry::new();
        let a = reg.issue(scope(1));
        let b = reg.issue(scope(2));
        reg.revoke_session(1);
        assert_eq!(reg.resolve(&a), None);
        assert!(reg.resolve(&b).is_some());
    }

    #[test]
    fn a_credential_past_the_liveness_window_stops_resolving() {
        let reg = Registry::with_window(Duration::from_millis(0));
        let token = reg.issue(scope(1));
        std::thread::sleep(Duration::from_millis(2));
        assert_eq!(reg.resolve(&token), None);
    }

    #[test]
    fn touching_a_session_keeps_its_credential_alive() {
        let reg = Registry::with_window(Duration::from_millis(50));
        let token = reg.issue(scope(1));
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(20));
            reg.touch_session(1);
        }
        assert!(
            reg.resolve(&token).is_some(),
            "a touched session must outlive a window shorter than the elapsed time"
        );
    }

    #[test]
    fn the_raw_token_is_never_stored() {
        let reg = Registry::new();
        let token = reg.issue(scope(1));
        let state = reg.state.lock().unwrap();
        assert!(
            !state.by_hash.contains_key(&token),
            "the map must be keyed by digest, never by the raw token"
        );
        assert_eq!(
            state.by_hash.keys().next().unwrap().len(),
            64,
            "hex SHA-256"
        );
    }

    #[test]
    fn minted_tokens_do_not_repeat() {
        let reg = Registry::new();
        let mut seen = std::collections::HashSet::new();
        for id in 0..64 {
            assert!(seen.insert(reg.issue(scope(id))), "token collision at {id}");
        }
    }
}
