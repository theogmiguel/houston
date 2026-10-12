# Connections

Connections lists the MCP servers Houston writes into the configuration for each managed CLI.
Open it from the left rail to see the server matrix for Claude Code, Codex, OpenCode and Cursor.

Each cell shows whether that CLI's copy is in sync, off or differs from Houston's list. Select a
cell to turn that server on or off for the matching CLI; Houston then applies the change. A
failed connection test includes its reason in the cell. Use **Edit** to change a server or
**Show diff** to compare a CLI copy with Houston's list.

Grok, Antigravity and ZCode can use MCP servers, but Houston does not manage their
third-party server configuration here. Houston's own pane tools are configured separately;
see [Installing Houston](install.md#providers).

Slack setup is also available in **Connections**. It can turn a mention into a task you
choose to start and return updates to the original thread; see [Slack requests](slack.md)
for permissions and network use.
