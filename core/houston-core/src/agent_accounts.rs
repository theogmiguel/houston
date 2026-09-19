use std::path::{Path, PathBuf};

/// `~`/`~/…`/`$HOME` expand against `home`; `~user/…` deliberately does not.
/// The result is exported verbatim as `CLAUDE_CONFIG_DIR`, where a literal `~`
/// segment would create a directory named `~` instead of using the home dir.
pub fn expand_tilde(raw: &str, home: &Path) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" || trimmed == "~\\" {
        return home.to_path_buf();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home.join(rest);
    }
    if trimmed == "$HOME" || trimmed == "$HOME\\" {
        return home.to_path_buf();
    }
    if let Some(rest) = trimmed
        .strip_prefix("$HOME/")
        .or_else(|| trimmed.strip_prefix("$HOME\\"))
    {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/dev")
    }

    #[test]
    fn tilde_and_home_expand_but_other_users_do_not() {
        let h = home();
        assert_eq!(
            expand_tilde("~/.claude-personal", &h),
            h.join(".claude-personal")
        );
        assert_eq!(
            expand_tilde("$HOME/.claude-work", &h),
            h.join(".claude-work")
        );
        assert_eq!(expand_tilde("~", &h), h);
        assert_eq!(expand_tilde("$HOME", &h), h);
        assert_eq!(
            expand_tilde("/opt/claude", &h),
            PathBuf::from("/opt/claude")
        );
        assert_eq!(
            expand_tilde("~root/.claude", &h),
            PathBuf::from("~root/.claude")
        );
    }

    #[test]
    fn whitespace_around_a_typed_path_does_not_change_its_meaning() {
        let h = home();
        assert_eq!(
            expand_tilde("  ~/.claude-personal  ", &h),
            h.join(".claude-personal")
        );
    }
}
