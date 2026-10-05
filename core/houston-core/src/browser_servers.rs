#[cfg(target_os = "linux")]
use houston_protocol::LocalServer;
#[cfg(target_os = "linux")]
use std::collections::{BTreeMap, HashSet};

// Limits one browser pane's control reply when a workspace has many listeners.
pub const MAX_LOCAL_SERVERS: usize = 32;

pub fn detect(processes: &[(u32, u32, String)]) -> (Vec<LocalServer>, bool) {
    #[cfg(target_os = "linux")]
    {
        detect_linux(processes)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = processes;
        (Vec::new(), false)
    }
}

#[cfg(target_os = "linux")]
fn detect_linux(processes: &[(u32, u32, String)]) -> (Vec<LocalServer>, bool) {
    let mut listeners = BTreeMap::<String, u16>::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in contents.lines().skip(1) {
            let columns: Vec<_> = line.split_whitespace().collect();
            if columns.len() < 10 || columns[3] != "0A" {
                continue;
            }
            let Some((address, port)) = columns[1].split_once(':') else {
                continue;
            };
            let loopback_or_wildcard = match address.len() {
                8 => matches!(address, "0100007F" | "00000000"),
                32 => {
                    address == "00000000000000000000000000000000"
                        || address == "00000000000000000000000001000000"
                }
                _ => false,
            };
            if !loopback_or_wildcard {
                continue;
            }
            let (Ok(port), inode) = (u16::from_str_radix(port, 16), columns[9]) else {
                continue;
            };
            listeners.insert(inode.to_owned(), port);
        }
    }

    let mut children = BTreeMap::<u32, Vec<u32>>::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let Some((_, rest)) = stat.rsplit_once(") ") else {
                continue;
            };
            let Some(parent) = rest
                .split_whitespace()
                .nth(1)
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };
            children.entry(parent).or_default().push(pid);
        }
    }

    let mut process_tree = Vec::new();
    let mut queue: Vec<_> = processes
        .iter()
        .map(|(pid, session, title)| (*pid, *session, title.clone()))
        .collect();
    let mut visited = HashSet::new();
    while let Some((pid, session, pane_title)) = queue.pop() {
        if !visited.insert(pid) {
            continue;
        }
        process_tree.push((pid, session, pane_title.clone()));
        queue.extend(
            children
                .get(&pid)
                .into_iter()
                .flatten()
                .map(|child| (*child, session, pane_title.clone())),
        );
    }

    let mut servers = BTreeMap::<u16, LocalServer>::new();
    for (pid, session, pane_title) in &process_tree {
        let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        let process = std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .unwrap_or_else(|_| "process".into())
            .trim()
            .to_owned();
        for entry in entries.flatten() {
            let Ok(target) = std::fs::read_link(entry.path()) else {
                continue;
            };
            let target = target.to_string_lossy();
            let Some(inode) = target
                .strip_prefix("socket:[")
                .and_then(|s| s.strip_suffix(']'))
            else {
                continue;
            };
            let Some(port) = listeners.get(inode) else {
                continue;
            };
            servers.entry(*port).or_insert_with(|| LocalServer {
                port: *port,
                process: process.clone(),
                session: *session,
                pane_title: pane_title.clone(),
            });
        }
    }

    let mut result: Vec<_> = servers.into_values().collect();
    let truncated = result.len() > MAX_LOCAL_SERVERS;
    result.truncate(MAX_LOCAL_SERVERS);
    (result, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_is_small_and_explicit() {
        assert_eq!(MAX_LOCAL_SERVERS, 32);
    }
}
