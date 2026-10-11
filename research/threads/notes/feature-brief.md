# Houston threads: decided design (input for gap research)

Houston today: local-first Linux-first Tauri desktop app + detached Rust daemon that owns real PTYs.
Agents (Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity) run as CLI processes in terminal
panes. Rail (240px, Orca-style) shows one card per grid, grouped by workspace; a grid is a split tree
of panes. Side panel: Diff, Files, Pull request, Browser, Overview. Orchestration: an agent spawns
child panes via MCP `pane_*` tools (cap 4 live children, depth 1), children report via an inbox;
children live in a roster inside the parent pane and can "Move to grid". Tasks (HOU-n), routines,
skills, PR watch, worktrees per child, hooks-based status (no screen scraping), OS keychain secrets.

Decided so far:
1. A **thread** is a new pane type (T3Code-style chat timeline driven by structured provider
   streams/ACP/app-server), living beside terminal panes in the same split tree. No global mode.
2. Rail unchanged: one card per grid. A grid with one thread plays the role of a T3Code thread.
3. Ctrl+N creates a new grid with one thread of the default provider, auto-named from the first prompt.
   Ctrl+Shift+N opens "New grid…": a composer with agent chips (pick agents + counts, prompt,
   Thread/Terminal toggle, checkout, "Customize each").
4. "Reopen as terminal" / "Reopen as thread" in the pane menu, only while the agent is idle, by
   resuming the same provider session. "Continue" on an ended session offers Thread or Terminal.
   Verified only for Claude (`claude --resume`, Agent SDK resume) and Codex (shared
   ~/.codex/sessions, app-server `thread/resume`).
5. Thread components adapted from T3Code: messages, queued/steer, reasoning, work log with turn
   fold, changed-files card, plan card, approvals and questions attached to the composer, secret
   request into OS keychain, compaction, errors/usage limits, worktree setup, checkpoint/fork,
   code/table/alert/mermaid, / and @ menus, terminal-excerpt chips from grid panes.
6. Orchestration in a thread follows the grid model: collapsed children strip inside the pane;
   timeline gets one "N children" row and Finished/Failed/Stopped rows; composer banners
   "Waiting on X" and "X needs you · Open question"; opening a child swaps the pane content
   (breadcrumb "Orchestrator / child", Move to grid); question answered in the child.
7. Attention rule: parent orchestrator handles child questions first; user is alerted only on
   explicit escalation (`pane_escalate`) or safety net (parent turn ended / parent closed);
   explicit permission requests in auto/bypass children go straight to the user.

Open: pane_spawn surface param (thread|terminal), per-provider protocol for threads, resume spike.
