//! `~/.ssh/config` reading, deliberately narrow: only `HostName`, `User`, `Port`
//! and `IdentityFile` under `Host` patterns. First obtained value wins — the
//! opposite of the usual last-wins intuition, and easy to get backwards.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostConfig {
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

pub fn default_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| Path::new(&h).join(".ssh").join("config"))
}

#[derive(Debug, Clone)]
pub struct HostBlock {
    pub patterns: Vec<String>,
    pub config: HostConfig,
}

impl HostBlock {
    /// A negated pattern that matches disqualifies the whole block, checked before
    /// any positive pattern: `Host * !secret.example.com` must not match
    /// `secret.example.com` merely because `*` did.
    pub fn matches(&self, host: &str) -> bool {
        let mut positive = false;
        for p in &self.patterns {
            if let Some(neg) = p.strip_prefix('!') {
                if glob_match(neg, host) {
                    return false;
                }
            } else if glob_match(p, host) {
                positive = true;
            }
        }
        positive
    }

    pub fn literal_alias(&self) -> Option<&str> {
        match self.patterns.as_slice() {
            [one] if !one.starts_with('!') && !one.contains('*') && !one.contains('?') => {
                Some(one.as_str())
            }
            _ => None,
        }
    }
}

/// Never fails: a malformed line is skipped, not an error. This file is the
/// user's and Houston is a guest in it, so refusing to connect over a keyword it
/// does not know would be absurd.
pub fn parse(text: &str) -> Vec<HostBlock> {
    let mut blocks: Vec<HostBlock> = Vec::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = match line.split_once(['=', ' ', '\t']) {
            Some((k, v)) => (
                k.trim().to_ascii_lowercase(),
                v.trim_matches(['=', ' ', '\t']),
            ),
            None => continue,
        };
        if value.is_empty() {
            continue;
        }
        if key == "host" {
            blocks.push(HostBlock {
                patterns: value.split_whitespace().map(str::to_string).collect(),
                config: HostConfig::default(),
            });
            continue;
        }
        let Some(block) = blocks.last_mut() else {
            continue;
        };
        match key.as_str() {
            "hostname" => block
                .config
                .hostname
                .get_or_insert_with(|| value.to_string()),
            "user" => block.config.user.get_or_insert_with(|| value.to_string()),
            "identityfile" => block
                .config
                .identity_file
                .get_or_insert_with(|| expand_tilde(value)),
            "port" => {
                if let Ok(p) = value.parse::<u16>() {
                    block.config.port.get_or_insert(p);
                }
                continue;
            }
            _ => continue,
        };
    }
    blocks
}

pub fn resolve(blocks: &[HostBlock], host: &str) -> HostConfig {
    let mut out = HostConfig::default();
    for b in blocks.iter().filter(|b| b.matches(host)) {
        if out.hostname.is_none() {
            out.hostname.clone_from(&b.config.hostname);
        }
        if out.user.is_none() {
            out.user.clone_from(&b.config.user);
        }
        if out.port.is_none() {
            out.port = b.config.port;
        }
        if out.identity_file.is_none() {
            out.identity_file.clone_from(&b.config.identity_file);
        }
    }
    out
}

pub fn load(path: &Path) -> anyhow::Result<Vec<HostBlock>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => {
            Err(anyhow::Error::new(e)).map_err(|e| e.context(format!("reading {}", path.display())))
        }
    }
}

/// Expand a leading `~/` through [`crate::home_dir::home_dir`] rather than raw
/// `HOME`: on Windows `HOME` is set by msys/git-bash but not a plain session, and
/// an unexpanded `~` would be persisted into the profile's stored key path.
fn expand_tilde(p: &str) -> String {
    match (p.strip_prefix("~/"), crate::home_dir::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).display().to_string(),
        _ => p.to_string(),
    }
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# work boxes
Host edge
  HostName edge-01.internal
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_edge

Host *.internal
  User fallback
  IdentityFile ~/.ssh/id_internal

Host build ci
  HostName build.internal
  ProxyJump bastion
";

    #[test]
    fn reads_the_four_keywords_it_claims_to_read() {
        let blocks = parse(SAMPLE);
        let c = resolve(&blocks, "edge");
        assert_eq!(c.hostname.as_deref(), Some("edge-01.internal"));
        assert_eq!(c.user.as_deref(), Some("deploy"));
        assert_eq!(c.port, Some(2222));
        let home = crate::home_dir::home_dir().expect("a test host must have a resolvable home");
        assert_eq!(
            c.identity_file.as_deref(),
            Some(home.join(".ssh/id_edge").display().to_string().as_str()),
            "IdentityFile must be tilde-expanded against the resolved home dir"
        );
        assert!(
            !c.identity_file.unwrap().contains('~'),
            "no unexpanded tilde may survive into a stored identity path"
        );
    }

    #[test]
    fn first_value_wins_across_blocks() {
        let blocks = parse(SAMPLE);
        let c = resolve(&blocks, "foo.internal");
        assert_eq!(c.user.as_deref(), Some("fallback"));

        let text = "Host x\n  User first\nHost *\n  User second\n";
        assert_eq!(resolve(&parse(text), "x").user.as_deref(), Some("first"));
    }

    #[test]
    fn ignores_keywords_it_does_not_claim() {
        let blocks = parse(SAMPLE);
        let build = blocks.iter().find(|b| b.matches("build")).unwrap();
        assert_eq!(build.config.hostname.as_deref(), Some("build.internal"));
        assert_eq!(build.config.user, None);
    }

    #[test]
    fn a_negated_pattern_disqualifies_the_whole_block() {
        let blocks = parse("Host * !secret\n  User everyone\n");
        assert_eq!(
            resolve(&blocks, "ordinary").user.as_deref(),
            Some("everyone")
        );
        assert_eq!(
            resolve(&blocks, "secret").user,
            None,
            "the negation wins even though `*` matched"
        );
    }

    #[test]
    fn accepts_the_equals_separator_and_odd_casing() {
        let blocks = parse("HOST x\n  hostname=h.example.com\n  PORT = 2200\n");
        let c = resolve(&blocks, "x");
        assert_eq!(c.hostname.as_deref(), Some("h.example.com"));
        assert_eq!(c.port, Some(2200));
    }

    #[test]
    fn skips_junk_instead_of_failing() {
        let blocks = parse("Host x\n  ???\n  Port notanumber\n  User ok\n");
        let c = resolve(&blocks, "x");
        assert_eq!(c.user.as_deref(), Some("ok"));
        assert_eq!(c.port, None, "an unparseable port is dropped, not guessed");
    }

    #[test]
    fn offers_only_literal_single_host_blocks_for_import() {
        let blocks = parse(SAMPLE);
        let names: Vec<_> = blocks.iter().filter_map(|b| b.literal_alias()).collect();
        assert_eq!(names, vec!["edge"]);
    }

    #[test]
    fn glob_matches_the_way_ssh_config_does() {
        assert!(glob_match("*.internal", "a.internal"));
        assert!(!glob_match("*.internal", "internal"));
        assert!(glob_match("web?", "web1"));
        assert!(!glob_match("web?", "web12"));
        assert!(glob_match("*", "anything"));
        assert!(!glob_match("a.c", "abc"));
        assert!(!glob_match("a+", "aaa"));
    }
}
