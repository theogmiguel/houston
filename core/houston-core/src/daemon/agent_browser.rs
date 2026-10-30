use super::*;

/// Absent means on: agents kept the browser tools they had before the switch existed.
const AGENT_BROWSER_KEY: &str = "agent_browser";

impl Daemon {
    pub fn agent_browser_enabled(&self) -> bool {
        self.db
            .get_setting(AGENT_BROWSER_KEY)
            .ok()
            .flatten()
            .as_deref()
            != Some("0")
    }

    pub fn set_agent_browser(&self, enabled: bool) -> Result<()> {
        self.db
            .set_setting(AGENT_BROWSER_KEY, if enabled { "1" } else { "0" })?;
        tracing::info!(
            "agent browser tools {}",
            if enabled { "enabled" } else { "disabled" }
        );
        self.mcp_notify.tools_changed_everywhere();
        self.broadcast_control(&proto::ServerMsg::AgentBrowser { enabled });
        Ok(())
    }
}
