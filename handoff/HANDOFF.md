# Houston v2 handoff

Working material for the `v2` branch. It is not product documentation: delete `handoff/` before any
merge to `main`. Everything a new session needs to continue is here; the original session's scratch
directory and its Linux worktrees stay on the Linux machine.

## 1. Where things are

| Item | State |
|---|---|
| PR #368 `feat(ui): a native look across the shell…` | Open for review, **do not merge** without the maintainer. Branch `feat/design-native`, HEAD `44b6474b`. |
| Branch `v2` | Created from `feat/design-native` (`44b6474b`) plus this `handoff/` commit. No v2 code yet. |
| Local-only worktrees (Linux) | `.houston/worktrees/design-native` (= PR branch), `design-native-primitives` (branch `feat/design-native-sidebar`, superseded: its sidebar work is in the PR), `design-native-tokens` (superseded). Remove once the PR merges. |
| Upstream research clones | Not committed. Re-clone read-only: `pingdotgg/t3code` at `9826dbb9` and `hardbeat920/monocode` at `1176861` (both 2026-10-28, both MIT). |

PR #368 verification: `typecheck`, `bun run test` (620 files, 5,099 tests), `build`, `check:css`,
`check:bundle` (970,241 bytes, budget 970,550) and every `safety-checks` script green. Rust suites not
re-run (no Rust diff vs `main`). Before/after captures are still owed on the PR: before =
`.design-ref/review/0/` in the design-native worktree; after = run `node scripts/capture-stories.mjs <outDir>`.

## 2. Decisions taken

1. **Houston v2 is a new product built in this repository.** The terminal-fidelity invariant in
   `AGENTS.md` no longer applies to v2 and must be rewritten when v2 lands. Panes become **threads**
   (structured conversations), not PTYs.
2. **Port T3 Code 1:1.** Read it line by line and write it in Houston: server, provider adapters,
   orchestration, thread UI. Not MonoCode code (MonoCode is UX reference only).
3. **Architecture:**
   - **Tauri (Rust)** replaces Electron: window, tray, updater, OS keychain,
     renderer watchdog, and a supervisor that starts, health-checks and restarts the server.
   - **Server in TypeScript with Effect**, ported from `t3code/apps/server` and `t3code/packages/*`,
     run as a Tauri sidecar. It owns threads, the event store (SQLite), providers (Claude via
     `@anthropic-ai/claude-agent-sdk`, Codex app-server, OpenCode server, ACP), git, PRs, worktrees,
     checkpoints, usage and **orchestration** (T3's is better than Houston's `pane_*`; it replaces it).
   - **Renderer = Houston's**, keeping the native design from PR #368, with T3's thread components
     ported into it, and Houston's sidebar: workspaces → named grids → one or more threads per grid.
   - `houston-core` (daemon), PTYs, hooks and the `/ws` protocol go away. Houston features T3 lacks
     (Night shift, task sources GitHub/Notion/Slack, workspace transfer, WSL) are decided per slice;
     default is to port or adapt them into the TS server, not keep a second backend.
4. **Licence:** T3 Code is MIT, "Copyright (c) 2026 T3 Tools Inc.". A 1:1 port is a derivative
   work. The maintainer keeps the notice (a clean-room rewrite was rejected: it would lose the
   robustness that is the reason for the port). Commit 0 on `v2` adds it to `NOTICE` and
   `third-party-licenses.config.json` at upstream commit `9826dbb9`; ported code may be pushed only
   after it.
5. **Branching:** one long-lived `v2` branch; one sub-branch per ported slice, merged into `v2`.
6. **Workforce:** opencode panes on the DeepSeek 4.1 models (effectively unlimited for the maintainer).
   Claude usage is limited: the full-redesign mock fan-out (7 Sonnet panes) hit the 5-hour limit.
7. **Not started:** implementation. The maintainer asked for the slice plan first, reviewed before any
   agent is launched.

## 3. Research findings

### 3.1 Servers: T3 Code is far more robust

| | T3 Code | MonoCode |
|---|---|---|
| Server | Separate Node/Bun process on Effect; ~232k lines in `apps/server/src`; state-dir ownership lock (`serverOwnership.ts`, like Houston's `daemon.lock`); optional boot service (systemd/launchd) | Local sessions spawned by the Tauri Rust layer (`src-tauri/src/harness.rs`), adapters in the renderer (`src/integrations/harness/providers`); `kill_all` on quit, so local sessions die with the app. Remote: a Node host with `node:sqlite` (`host/store.ts`) that survives |
| Claude | Agent SDK: `orchestration-v2/Adapters/ClaudeAdapterV2.ts` (~11.2k lines, 15k test lines) | Raw CLI `stream-json` protocol: `claudeProtocol.ts` (`--output-format/--input-format stream-json`, `--permission-prompt-tool stdio`, control messages `initialize`, `can_use_tool`, `interrupt`, `control_cancel_request`) |
| Persistence | SQLite event store (`persistence/OrchestrationEventStore.ts`), projections (`orchestration-v2/ProjectionStore.ts`), outbox (`EffectOutbox.ts`), command receipts, recovery (`ProviderRuntimeRecoveryService.ts`); 84 migration files | SQLite on the remote host; files/stores locally |
| Providers | `orchestration-v2/Adapters/*AdapterV2.ts`: Claude, Codex (`packages/effect-codex-app-server`), ACP (`packages/effect-acp`), OpenCode 2, Antigravity, Cursor, Grok, Pi, Fx, Muse; each with a testkit and recorded replay fixtures (`record:claude-replay`) | Many providers, each its own protocol in the frontend |

**How T3 uses the Claude Agent SDK** (`ClaudeAdapterV2.ts`): one long-lived `query()` per thread with
streaming input (prompt is an async iterable fed by a queue, ~line 950), so queue and steer need no
reopen; `interrupt()` (~1221); approvals via `canUseTool` (~9394, 9626); `resume`, `resumeSessionAt`
(~9764), `forkSession` (~1259); `setModel`, `setPermissionMode`; custom spawn with process groups and
`windowsHide` (~994); MCP credentials via `setMcpServers` after start, never in argv (~1050);
partial messages coalesced (`ProviderTextDeltaCoalescer.ts`).

**Rust vs TS SDK:** there is no official Rust SDK (TS and Python only). The SDK is a wrapper over the
CLI's `stream-json` + control protocol, so a Rust client is feasible (MonoCode does it in TS without the
SDK), but that protocol is internal and changes with CLI versions. Chosen: the TS SDK in the sidecar.
Its cost is one extra JS runtime process (every `claude` session already is one) and a bundled runtime;
Electron's weight is unrelated to the SDK. Unmeasured guesses: tens of MB idle RAM, tens of MB on disk.
The Agent SDK is not MIT; it ships under Anthropic's own terms: read them before shipping.

### 3.2 Frontends: T3 for the thread, MonoCode for the multi-session shell

| | T3 Code (`apps/web/src`, ~170k TSX lines) | MonoCode (`src/features`, ~106k TSX lines) |
|---|---|---|
| Timeline | Virtualized (`@legendapp/list`, `components/chat/MessagesTimeline.tsx`), scroll anchoring (`timelineScrollAnchoring.ts`), follow (`useTimelineFollow.ts`), position restore, minimap, find in thread (`threadFind*.ts`), rewind (`useTimelineRewind.ts`) | Not virtualized; one 5.5k-line `sessions/ui/AgentTranscript.tsx` |
| Streaming markdown | Incremental (`markdown-incremental.ts`), code, tables, math, mermaid, GitHub alerts | `streamdown` + `shiki` |
| Tools | Work groups (`TimelineWorkGroupRows.tsx`), command output panel, subagent bar | Role blocks; pending approvals stay actionable while work is collapsed (`AgentTranscript.tsx:3529`) |
| Approvals/questions | `TimelinePendingApprovalRow.tsx`, `ComposerPendingApprovalActions.tsx`, `ComposerPendingUserInputPanel.tsx`, secret and link request cards | `approval` block |
| Composer | TipTap rich editor (`ComposerPromptEditorTiptap.tsx`): mentions, slash commands, code blocks, attachments, stash, multi-model send; dispatch modes `auto`/`start`/`steer` and an editable queue (`QueuedRunsControl.tsx`) | Textarea with attachments, plan mode, drafts; queue only |
| Several threads visible | Not found: one thread in focus plus right panels | Yes: `workspace/ui/PaneTree.tsx`, a split tree with ratios (like Houston grids) |
| Stack | React, TanStack Router, Zustand, Base UI, Tailwind 4 | React 19, Tailwind 4, xterm |

Take from T3: the virtualized timeline, incremental markdown, work groups with visible pending
approvals, the three composer intents plus editable queue, find and rewind. Take from MonoCode
(as UX only): pane split tree. Keep from Houston: sidebar workspaces → grids → threads, the native
design, settings, pages. Virtualization is a day-one requirement: 4–6 streaming threads per grid on
WebKitGTK will not survive full re-renders.

### 3.3 Capy (from the maintainer's own analysis, kept off this public repo)

Durable hosted thread identity; the agent loop runs on Capy servers and machines only execute tools;
"Run on" federation (cloud / this PC); Git-pack handoff of staged/unstaged/untracked; verified file
transfer; composer intents queue / steer-next-step / interrupt; optimistic send with a client key;
paged events; the read marker advances only when the window is visible and at the tail. Electron, no
independent daemon, thread history stored by the service. Take the thread ideas, not the hosting.

## 4. The redesign (PR #368) and the unfinished full-redesign mock

- Design reference: `handoff/mocks/houston-mocks.html` (direction B "Native"). Build it from
  `houston-mocks.base.html` + `fragments/*.html` with `python3 handoff/mocks/build-mock.py`; capture with
  `node handoff/mocks/shot-views.mjs <html> <outDir> <viewRegex>` (edit the Playwright path at the top).
  `houston-mocks.before-full-redesign.html` is the mock before the full-app extension.
- The maintainer asked for **every** screen, modal and menu to be mocked and reviewed (apple-design
  plus the mock's rules) before implementation. Status of the seven fragments, cut off by the usage limit:

  | Fragment | Views | State |
  |---|---|---|
  | `browser` | 37 | Done. A/B: browser chrome (single bar vs address bar + labelled picker row) and side-panel tabs (strip vs "3 tabs" popover) need a pick. Composer host is a guess. |
  | `prs` | 62 | Done. A/B list + detail (inspector column vs other) needs a pick. Paper only partly reviewed. |
  | `side` | 107 | Builds clean. apple-design and visual review not done. A/B panel structure: tabs card vs docked switcher. |
  | `rail` | 67 | Builds clean, ~30 reviewed. Bugs: `settings-none` rows not hidden; add-pane marks blank. Open: drop the "Agent activity" sort? "Cards show" and the Layout panel still exist. |
  | `settings`, `nav`, `orch` | ? | Written but cut off; no result submitted. Build and inspect before trusting. |

  Brief: `handoff/mocks/brief-mock-fragment.md` (read its final "Correction" section). Inventory of all
  456 harness stories by family: `handoff/mocks/inventory.md`.
- **With v2, the pane becomes a thread**, so the next mock to make is the thread pane (timeline,
  tool groups, approvals, composer intents) in the native style; revisit the fragments after it.
- Earlier plan and notes: `handoff/redesign/plan-design-b.md`, `brief-executor.md`, `papercuts.md`.
  Open papercut: BrowserSurface lost its persist-error warning band in the side-panel refactor; the
  maintainer has not decided whether to file an issue.

## 5. Next steps

1. **Slice plan for the T3 port** (maintainer reviews it before any agent starts). Proposed shape:
   - Order: `packages/contracts` and shared → persistence/event store → provider core + Claude adapter
     → Codex, OpenCode, ACP adapters → orchestration-v2 → git/PR/worktrees/checkpoints → MCP toolkits
     (orchestration tools) → Tauri supervisor for the sidecar → renderer thread components → sidebar
     integration (grids of threads) → remaining Houston features.
   - Acceptance per slice: port the slice's T3 tests first; the slice lands only with them green, plus
     a sampled human-level review and a full gate at each integration into `v2`.
   - One sub-branch per slice, opencode + DeepSeek 4.1 workers, briefs in English.
2. Mock the thread pane in `handoff/mocks/houston-mocks.html`.
3. Done in commit 0: the MIT notice. Collaboration plan for two maintainers: `PLAN.md`.
4. Rewrite `AGENTS.md` invariants for v2 when its architecture lands.

## 6. Traps learned in this session

- Heavy work on Linux runs under `scripts/oom-shield.sh` with `nice -n 19`; its lock serializes
  workloads. Never `git stash` in shared worktrees; stage explicit paths.
- `bun run test`, not `bun test`. `check:css` and `check:bundle` read build output: build first.
  Re-cut `ui/bundle-budget.json` with a recorded reason when the boot payload grows.
- `pane_prompt` in `steer` mode is refused while a previous instruction is pending; `queue` waits for
  the turn to end. There is no way to type free text into a running Claude pane.
- Parallel Claude panes on high effort exhaust the 5-hour plan quickly; images (captures) are the
  costliest input.
- The mock's fragment views must land inside the base `.content` element (fixed in `build-mock.py`).
- `@effect` is pervasive in T3's server: porting without Effect is a rewrite, not a port.
