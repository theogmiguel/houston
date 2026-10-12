# MCP servers

Settings ▸ Agents ▸ MCP servers lists the MCP servers Houston writes into the configuration for each managed CLI.
Use it to manage the server configuration applied to Claude Code, Codex, OpenCode and Cursor.

Each cell shows whether that CLI's copy is in sync, off or differs from Houston's list. Select a
cell to turn that server on or off for the matching CLI; Houston then applies the change. A
failed connection test includes its reason in the cell. Use **Edit** to change a server or
**Show diff** to compare a CLI copy with Houston's list.

Grok, Antigravity and ZCode can use MCP servers, but Houston does not manage their
third-party server configuration here. Houston's own pane tools are configured separately;
see [Installing Houston](install.md#providers).

Slack setup is available from Tasks ▸ Sources ▸ Slack. It can turn a mention into a task you
choose to start and return updates to the original thread; see [Slack requests](slack.md)
for permissions and network use.

Connection checks run or contact the configured MCP server. Network-backed servers receive
the connection test; local servers run on this machine. Adding, editing or removing a
server applies the managed configuration to its selected CLIs.
