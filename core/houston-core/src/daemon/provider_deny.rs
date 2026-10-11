use super::*;

// Read only the launched process's effective configuration roots, never log its environment.
#[cfg(target_os = "linux")]
fn effective_roots(
    session: &Session,
    provider: proto::AgentKind,
) -> Result<(PathBuf, Option<PathBuf>)> {
    let pid = session.pid.ok_or_else(|| {
        anyhow!("deny refused for {provider:?}: effective process configuration is unavailable")
    })?;
    let mut environment = Vec::new();
    std::fs::File::open(format!("/proc/{pid}/environ"))?
        .take(65_537)
        .read_to_end(&mut environment)?;
    anyhow::ensure!(environment.len() <= 65_536,
        "deny refused for {provider:?}: process environment exceeds 65536 bytes; effective bindings cannot be verified");
    let value = |key: &str| -> Option<String> {
        let prefix = format!("{key}=");
        environment.split(|byte| *byte == 0).find_map(|item| {
            std::str::from_utf8(item)
                .ok()?
                .strip_prefix(&prefix)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        })
    };
    let home = value("HOME").map(PathBuf::from).filter(|path| path.is_absolute())
        .ok_or_else(|| anyhow!("deny refused for {provider:?}: effective HOME is unavailable; expected an absolute configuration root"))?;
    let profile = match provider {
        proto::AgentKind::Claude => value("CLAUDE_CONFIG_DIR"),
        proto::AgentKind::Antigravity => {
            anyhow::ensure!(value("GEMINI_CLI_HOME").is_none(), "deny refused for Antigravity: GEMINI_CLI_HOME is set; effective denial bindings cannot be verified; use pane_escalate");
            None
        },
        _ => None,
    }.map(|raw| {
        let path = PathBuf::from(raw);
        if path.is_absolute() { path } else { Path::new(&session.info.cwd).join(path) }
    });
    Ok((home, profile))
}

#[cfg(any(target_os = "linux", test))]
fn require_default_bindings(provider: proto::AgentKind, path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => bail!("deny refused for {provider:?}: customized bindings at {}; expected verified default denial bindings; use pane_escalate", path.display()),
        Err(error) => bail!("deny refused for {provider:?}: cannot verify bindings at {}: {error}; use pane_escalate", path.display()),
    }
}

#[cfg(any(target_os = "linux", test))]
fn default_bytes(
    provider: proto::AgentKind,
    home: &Path,
    profile: Option<&Path>,
) -> Result<&'static [u8]> {
    match provider {
        proto::AgentKind::Claude => {
            let root = profile.map(Path::to_path_buf).unwrap_or_else(|| home.join(".claude"));
            require_default_bindings(provider, &root.join("keybindings.json"))?;
            Ok(b"\x1b") // Claude confirm:no.
        }
        // Codex bottom_pane handles Esc through ApprovalOverlay::on_ctrl_c (cancel/deny).
        proto::AgentKind::Codex => Ok(b"\x1b"),
        // Grok Esc parks the permission card; Ctrl+C cancels the request.
        proto::AgentKind::Grok => {
            require_default_bindings(provider, &home.join(".grok/keybindings.json"))?;
            Ok(b"\x03")
        }
        proto::AgentKind::Antigravity => {
            let root = profile.map(Path::to_path_buf).unwrap_or_else(|| home.join(".gemini"));
            require_default_bindings(provider, &root.join("antigravity-cli/keybindings.json"))?;
            require_default_bindings(provider, &root.join("config/keybindings.json"))?;
            Ok(b"n") // confirm.no acts immediately; Enter could answer the next prompt.
        }
        proto::AgentKind::Opencode => bail!("deny refused for OpenCode: permission stages and feedback do not have a verified denial sequence; use pane_escalate"),
        proto::AgentKind::Cursor => bail!("deny refused for Cursor: no supported NeedsInput permission evidence or verified denial sequence; use pane_escalate"),
        other => bail!("deny refused for {other:?}: no verified provider denial sequence; use pane_escalate"),
    }
}

pub(super) fn bytes(session: &Session, provider: proto::AgentKind) -> Result<&'static [u8]> {
    anyhow::ensure!(session.acp.is_none(),
        "deny refused for {provider:?} ACP stream: no supported typed permission response API; use pane_escalate");
    anyhow::ensure!(session.info.agent == provider,
        "deny refused for {provider:?}: effective bindings of an agent adopted inside {:?} cannot be verified; use pane_escalate", session.info.agent);
    #[cfg(target_os = "linux")]
    {
        let (home, profile) = effective_roots(session, provider)?;
        default_bytes(provider, &home, profile.as_deref())
    }
    #[cfg(not(target_os = "linux"))]
    {
        bail!("deny refused for {provider:?}: effective process bindings cannot be verified on this platform; use pane_escalate")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_have_only_the_verified_deny_bytes_and_custom_bindings_refuse() {
        let home = tempfile::tempdir().unwrap();
        for (provider, expected) in [
            (proto::AgentKind::Claude, b"\x1b".as_slice()),
            (proto::AgentKind::Codex, b"\x1b".as_slice()),
            (proto::AgentKind::Grok, b"\x03".as_slice()),
            (proto::AgentKind::Antigravity, b"n".as_slice()),
        ] {
            assert_eq!(
                default_bytes(provider, home.path(), None).unwrap(),
                expected
            );
        }
        let profile = home.path().join("account");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("keybindings.json"), "{}").unwrap();
        assert!(
            default_bytes(proto::AgentKind::Claude, home.path(), Some(&profile))
                .unwrap_err()
                .to_string()
                .contains("customized bindings")
        );
        let agy = home.path().join(".gemini/antigravity-cli");
        std::fs::create_dir_all(&agy).unwrap();
        std::fs::write(agy.join("keybindings.json"), r#"{"confirm.yes":"n"}"#).unwrap();
        assert!(
            default_bytes(proto::AgentKind::Antigravity, home.path(), None)
                .unwrap_err()
                .to_string()
                .contains("customized bindings")
        );
        for provider in [
            proto::AgentKind::Opencode,
            proto::AgentKind::Cursor,
            proto::AgentKind::Shell,
        ] {
            assert!(default_bytes(provider, home.path(), None).is_err());
        }
    }
}
