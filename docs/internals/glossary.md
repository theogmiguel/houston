# Glossary

Words that collide, and the meaning Houston gives them. Where a term has a home in code, it is
named.

## People and roles

| Term | Meaning |
|---|---|
| **you** | The coding agent changing Houston. May itself be running inside a Houston pane (`HOUSTON_SESSION` is set). |
| **maintainer** | Develops and releases Houston. A maintainer's installed app and its sessions use the same protected release channel as any user's install. |
| **user** | The person running Houston to direct agents. One per install. |
| **dogfooding** | Running Houston's own development inside Houston panes. `env_hygiene.rs` scrubs inherited agent markers so a dogfooded daemon does not leak its identity into what it spawns. |
| **orchestrator** | A session role: decomposes work, briefs sub-agents, runs gates, commits. Never implements directly. |

## Product nouns

| Term | Meaning | Code |
|---|---|---|
| **agent** | A coding agent Houston hosts in a pane (Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok). | `proto::AgentKind` |
| **provider / CLI** | The agent runtime Houston launches and talks to. Each has a launch shape (`launch.rs`) and, for six of them, a hook installer. | `launch.rs`, `agent_events.rs` |
| **session** | One PTY (or SSH channel) running an agent CLI or a shell in a project directory. Has a process `state` and, orthogonally, an agent `status`. | `daemon.rs::Session` |
| **pane** | A session's cell in the grid. Its identity (`LeafNode.id`) outlives the session in it. | `layout/tree.ts` |
| **workspace** | A project directory the daemon knows. Sessions belong to one; hooks are installed per workspace. `workspace_id` on the wire and in `pane_inbox` is the workspace's own path — Houston's only workspace key, so no separate id table can drift from it. | `db.rs::workspaces` |
| **grid** | A named layout under a workspace holding a split tree. Renderer state only (`tr-grids:<path>`, `tr-layout:<path>::<gridId>`). | `layout/tree.ts::GridMeta` |
| **stack** | A tabbed group of panes in one grid slot, capped at 4. | `StackTabs.tsx` |
| **codename** | A pane's auto-generated name, from a fixed pool, replaced by a better name as one arrives. | `pane_name.rs` |
| **title source** | Where a pane's current name came from — codename, first prompt, the CLI's own window title, or the user. A weaker source never overwrites a stronger one. | `daemon.rs`, `osc_title.rs` |
| **Tidy** | The topbar action that rebalances the grid into even splits. | `App.tsx` |
| **rail** | The left sidebar: nav rows plus the workspace tree. 240 px, hide/show. | `Sidebar.tsx` |
| **Custom** | The background mode (Settings ▸ Appearance ▸ Background): one image behind the whole window instead of the theme's flat ground. Solid is the default. | `backgroundMode.ts` |
| **the field** | The dithered image Custom paints as a single surface behind everything — rail, topbar, gutters and panes. | `backdrop/`, `CustomBackdrop.tsx` |
| **scrim** | The translucent coat a surface wears over the field to keep its own ink legible: the chrome scrim on the rail and topbar, the pane scrim on terminals. | `--custom-chrome-scrim`, `--custom-pane-scrim` |
| **the band** | The bounded luminance Custom's dither clamps its output into (dark themes cap the bright end, paper lifts the dark end) — the invariant that lets a build-time gate prove chrome legibility against an image it has never seen. | `backdrop/dither.ts` |
| **Glass (retired)** | The window mode Custom replaced: a blurred sheet behind the chrome. The name survives only in the overlay tier (`raised-glass` / `overlay-glass`) and the `tr-glass-mode` migration. | `material.ts`, `backgroundMode.ts` |
| **Source control** | The workspace's right panel, with Changes and Pull request tabs; it is not a grid pane. | `SourceControlPanel.tsx`, `ChangesPane.tsx`, `git.rs`, `gh.rs` |
| **browser pane** | A native child webview in a grid slot, driven by the user or by an agent through `browser_*` MCP tools. | `src-tauri/src/browser/` |
| **profile** | A saved per-provider account/config-dir choice applied at spawn. | `agent_profiles` |
| **routine** | A standalone workspace automation: a named prompt with a cadence and its own execution settings (engine, model, effort, working directory, permission mode, isolation). Fired by `routine_fire_loop` on its cadence, attended or not; `routine_run_now` fires the same path by hand with `trigger = Manual`. | `routines.rs`, `daemon.rs::routine_fire_in_pane` |
| **run** | One firing of a routine, recorded independently as a `routine_runs` row (trigger, status, its pane session, timestamps, error) — never only a message. Every run starts a fresh terminal pane with a fresh context; nothing resumes. Ends with a typed `RoutineOutcome`. | `db.rs::routine_runs`, `daemon.rs::RoutineRun` |
| **handoff** | Giving a pane's conversation to a DIFFERENT CLI: the packet (the pane's thread plus the operator's ask) a new pane is launched with. | `PaneHandoff.tsx`, `handoffPacket.ts` |
| **handoff document** | The older, generative form: a budgeted prompt assembled from a pane's command blocks, written by a hidden CLI session. Wire and daemon only — no UI door. | `handoff.rs` |

## Runtime nouns

| Term | Meaning | Code |
|---|---|---|
| **daemon** | `houston-core`, run detached — spawned by `houston-supervisor` on Linux or directly on Windows — and outliving the app, which connects to it as a `/ws` client rather than linking it in. Owns PTYs, DB, hooks, MCP for one channel. | `core/houston-core` |
| **supervisor** | `houston-supervisor`, Linux-only: forks `houston-core` as its child, writes `supervisor.json` beside `daemon.json`, and is what makes the daemon survive an app crash or a `kill` of the app itself. Not present on Windows, where the app spawns `houston-core.exe` directly. | `core/houston-core/src/bin/houston-supervisor.rs` |
| **handoff** | A live transfer of a running daemon's sessions to a new generation on the same channel (Linux only), over `/manage`'s `daemon_handoff` — refused by name, preserving the old daemon, for a live SSH session, a schema-changing candidate, an exceeded cap, or any unsupported platform. What `dev.sh --fresh` and a supported upgrade use before falling back to the orderly stop. | `daemon.rs::begin_handoff`, `adoption.rs` |
| **tray** | The app's status icon in the desktop's notification area: a live header, the panes actually waiting on you listed inline, the rest one click away in an `Agents` submenu grouped by workspace, and one way out (quit, which stops the daemon and every agent under it). Closing the window is how you leave them running. Fed by the RENDERER through the `tray_sync` command, never by the daemon, and never over `/ws`. On Linux its availability is probed, not assumed — nothing owning `org.kde.StatusNotifierWatcher` means no icon and no hide-to-tray. | `src-tauri/src/tray/` |
| **channel** | One isolated state universe under `$HOME`: `release` → `~/.houston`, else `~/.houston-<name>`. | `paths.rs` |
| **state dir** | The channel's directory. Everything the daemon persists lives under it. | `paths.rs` |
| **`daemon.json`** | `{ port, token, pid, protocol, pid_creation, supervisor_pid?, generation? }` for helpers, scripts and the app's own connect-or-spawn boot. `generation` is a handoff candidate's own commit record — absent for a normally-booted daemon. Not how the renderer connects. | `main.rs` |
| **`daemon.lock`** | The advisory `flock` that makes a channel single-owner. Held only by the daemon — the app never takes it. | `lock.rs` |
| **`--daemon-fresh`**/**`--fresh`** | Request an orderly stop of the recorded daemon over `/manage`'s `daemon_shutdown` (identity-checked wait, never a signal), then start clean. Refused from a pane on the same channel. | `daemon_host.rs`, `dev.sh` |
| **`/manage`** | The daemon's management endpoint, separate from `/ws`: `daemon_status`/`daemon_shutdown`/`daemon_handoff`, bearer-authenticated with the daemon token. What `--status`, `--daemon-fresh` and the Settings *Daemon* section all talk to. | `server.rs`, `protocol/protocol.md` |
| **helper** | The `hook` / `hs-pane` argv aliases; `tr-helper` is the slim binary form. A `hs-mail` invocation answers with a refusal naming its replacement. | `bin/tr-helper.rs` |
| **hooks** | The CLI's own lifecycle events Houston subscribes to. Claude: `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`. | `claude_hooks.rs`, `agent_hooks.rs` |
| **drop file** | How a hook reaches the daemon: one JSON file under `hooks/drop/`, claimed by hard-link, applied by the poll loop. | `hook_drop.rs` |
| **managed marker** | The `--houston-managed[=<channel>]` sentinel that identifies Houston's entries in another tool's config, so uninstall removes exactly ours. | `claude_hooks.rs` |
| **`AgentStatus`** | `Spawning`, `Working`, `Idle`, `NeedsInput`. Set only by `Daemon::set_status`, sourced from hooks or ACP. | `proto::AgentStatus` |
| **`hooks_seen`** | Per-session flag: at least one hook event has arrived. Stands the spawn-grace watchdog down. | `daemon.rs::Session` |
| **husk** | A restored session record with no live process. Reaped when idle and childless; never resumed. | `daemon.rs::dead` |
| **ACP** | Agent Client Protocol: line-delimited JSON-RPC on the PTY, a second lawful status source. In a pane Houston never answers its permission requests; a headless ACP turn does, through `headless/acp.rs`. | `acp.rs` |
| **headless engine** | An agent CLI driven with no PTY through the `HeadlessEngine` seam: argv, stdin, decoded stdout, reply. Claude, Codex, OpenCode, Grok; Antigravity and Cursor are pane-only, refused by name. | `headless/` |
| **liveness** | A kernel fact from procfs: does the session's pid have children. Gates the reaper and the close confirmation, never a status. | `has_child_procs` |
| **ring** | A session's capped byte buffer of everything its PTY ever wrote, minus what has been trimmed off the front. The replay and restore path; not text. | `scrollback.rs` |
| **tail** | The ring split on newlines, ANSI-stripped, each line collapsed to what a bare carriage return left showing. Right for a CLI that prints lines; on one that repaints it is one line. | `Scrollback::tail_lines` |
| **watched** | Whether any terminal engine is on the other end of a pane — a Tauri output sink, or a `/ws` connection taking its frames. It is what picks the answerer for a pane's terminal queries: the renderer's engine while watched, the daemon's own emulator while not. | `Session::watched`, `vt.rs` |
| **screen** | What a pane is SHOWING: the session emulator's grid at the pane's current size, trailing blanks trimmed, plus as much history as its budget holds. | `vt.rs` |
| **emulator** | The libghostty-vt terminal the daemon owns for a session — the same library the renderer paints with, built natively from the same pinned revision. Fed every PTY chunk after the redactor; read for attach, screens and terminal queries; never for status. | `vt.rs`, `ghostty-vt.lock` |
| **snapshot** | One versioned, architecture-portable export of an emulator's whole state at an output cutoff: both screen buffers, the active one, cursor and saved cursor, modes, the kitty keyboard flag stack, mouse tracking, bounded history with styles and hyperlinks, and the escape sequence still in flight. What a pane reattaches FROM, in place of a byte replay, and what the handoff manifest carries. Not a screenshot and not a scrollback replay. | `houston_snapshot.zig`, `protocol/protocol.md` |

## Orchestration nouns

| Term | Meaning | Code |
|---|---|---|
| **orchestration** | Agent-spawns-agent. An agent in a pane opens, prompts, reads, waits on and kills child panes. | `orchestrate.rs`, `mcp_orchestration.rs` |
| **`pane_*`** | The MCP verbs: `pane_spawn`, `pane_list`, `pane_get`, `pane_read`, `pane_prompt`, `pane_wait`, `pane_send_keys`, `pane_kill`, `pane_submit`, plus `workspace_info`. | `mcp_orchestration.rs` |
| **`hs-pane`** | The same verbs as a CLI, for agents without MCP. A shell wrapper the daemon writes at spawn. | `orchestrate.rs::run_pane_cli` |
| **inbox** | One row per signal a pane owes another pane (or the operator), in the `pane_inbox` table. Producers write rows; the three doors read them. | `pane_inbox`, `InboxKind` |
| **inbox row** | One signal: `kind` (`result` \| `no_handback` \| `needs_input` \| `exited` \| `stalled` \| `operator_note` \| `mail`), a redacted `summary`/`body`, optional `artifacts`, and three timestamps — `created_at` (persisted), `delivered_at` (sent), `confirmed_at` (proven). | `db::InboxRow` |
| **door** | One of the three delivery mechanisms: door 1 returns rows inside a live `pane_wait`; door 2 prints them from a Working parent's own `Stop` hook; door 3 pastes them into an idle parent. Ordered by the parent's state. | `orchestrate.rs` |
| **episode** | One permission block, from the event that named its tool (`PermissionRequest`, Antigravity's `PreToolUse` on an ask tool) to the evidence that that execution moved on. Keyed by the CLI's invocation id where it has one, else by `(prompt_id, tool_name, generation)`. | `orchestrate.rs::PermissionEpisodes` |
| **round** | One accepted external request's worth of sub-agent activity — the object the withheld-turn-end rule operates on. Opens once per external request, travels as `delegations.round` / `request_id`, closes when both the in-flight and owed sets drain. | `orchestrate.rs::SubagentRound` |
| **delegation** | The durable record one spawn opens: brief, lifecycle state (`spawning → working ⇄ needs_input`, closing `done|failed|cancelled|unknown`), and the `round` counter. What the child hands back is a `pane_inbox` row, never a slot on this record. | `db.rs::delegations` |
| **brief** | What a child is asked to do: `prompt` plus the optional `output_format` (the shape of the answer) and `boundaries` (what it must not do), composed into ONE instruction before launch. Not three fields on the wire past that point. | `orchestrate.rs::Brief` |
| **artifact** | A file a worker names in its handback instead of quoting it. Resolved, required to exist, and held inside the workspace; the parent gets the path. | `orchestrate.rs::Submission` |
| **staging** | A `pane_submit` while the child works writes a row with `ready_at = NULL` — stored but not eligible. The round close sets `ready_at` in the same transaction that moves the delegation, and a second answer to the same request replaces the first in place (counted in `superseded`) while it is unreserved. | `daemon.rs::orchestrate_submit` |
| **`TurnEndSource`** | Which signal released a stored result: `stop-hook`, `acp-turn`, or `quiet-settle`. Only the last is a judgement, so only it is named to the parent. | `orchestrate.rs` |
| **quiet-settle** | Turn end inferred from a still screen with nothing running under the pane, for a CLI that reports none. The third named content exception. | `daemon.rs::delegation_settle_pass` |
| **`stalled`** | A flag on a live delegation — no output for `DELEGATION_STALL_MS` with nothing running. Never a state; clears on the child's next byte. | `daemon.rs::delegation_stall_pass` |
| **`children_waiting`** | How many of a pane's live children are blocked or stalled. A daemon-derived scalar on `SessionInfo`, not a client-side reduction — the renderer holds no roster of a parent's children. | `daemon.rs::child_counts_of` |
| **`DelegationInfo`** | The delegation record as the RENDERER reads it: `DelegationView` minus `brief`, with typed `state`/`turn_end_source`. Pushed by `DelegationChanged`. | `houston-protocol` |
| **orchestration card** | The RAISED-tier panel behind a pane header's `⑂`/`↳` badge: a parent's is a roster of its children, a child's is its own record. Focus is its only lever. | `DelegationCard.tsx` |
| **role** | A parent's own short name for one child (`reviewer`), unique among ITS live children and freed when that pane dies. | `orchestrate.rs::validate_role` |
| **child slot** | One of `MAX_LIVE_CHILDREN = 4` per parent; **depth** is capped at `MAX_SPAWN_DEPTH = 1`. Both settable up to a wire cap. | `orchestrate.rs` |
| **auto mode** | A spawned child starts in its CLI's approval-bypass mode; a model that cannot run it is refused by name. | `launch.rs`, `orchestrate.rs` |
| **MCP credential** | A per-pane bearer token bound to `{ workspace, session }`; only its SHA-256 is stored. | `mcp_creds.rs` |
| **mailboxes** | Legacy file-based storage. Current pane-to-pane mail uses `pane_inbox`; the scope directory at `<root>/.houston/swarm/<id>/` remains for compatibility and `plan/events/` garbage collection. | `scope.rs` |
| **swarm** | Legacy prefix for orchestration scope infrastructure, tables and events. | `swarm_*` |
| **`hs-mail`** | Unsupported compatibility alias. Returns a refusal naming its replacement and exits non-zero. | `main.rs`, `bin/tr-helper.rs` |

## Engineering nouns

| Term | Meaning |
|---|---|
| **the wire / `PROTOCOL_VERSION`** | The `/ws` schema in `houston-protocol`; exact-match versioned, bumped once per wire-touching batch. |
| **safety scripts** | The 25 hermetic `scripts/check-*.sh` steps the `safety-checks` CI job runs on every push. |
| **oom-shield** | `scripts/oom-shield.sh`: a memory-capped, niced, serialized scope for heavy builds. |
| **gate** | The verification set for a cadence: focused checks while iterating, full checks at integration boundaries and before a push. |
| **discriminator** | The specific re-run that distinguishes a known flaky shape from a real failure. |
| **typeable** | A pane whose engine is live, which holds focus, and whose daemon link is up — the first instant a keystroke reaches the PTY. `TerminalPane` publishes it as `data-typeable`; `--bench=M10` stamps it as `focused-pane-typeable`. Not "painted": keys work well before the scrollback replay draws. |
| **cold boot / warm restore** | The two boot conditions `scripts/boot-baseline.sh` measures. Cold: a channel with no sessions, so nothing to restore and no pane to type into. Warm: a channel whose boot restore brings sessions back — the boot a returning user gets. |
