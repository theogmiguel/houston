# Threads in Houston: design status

Parked research branch. Nothing here is decided for implementation, and this branch is not
meant to be merged: it holds working material that `AGENTS.md` keeps out of `main`.

A **thread** is a chat-style pane (T3Code-like timeline) that would live beside terminal
panes in the same grid, driven by a provider's structured protocol instead of a PTY.

## Contents

| Path | What it is |
|---|---|
| `mocks/houston-threads.html` | High-fidelity mocks: launcher, thread screens, orchestration (screen 5 and the attention rule), Continue as thread or terminal (screen 6), architecture verdict, 31 gaps, component catalogue. Open it in a browser. |
| `notes/feature-brief.md` | Short brief of the decided UX, written for the gap researchers. |
| `notes/gaps-tern.md`, `notes/gaps-t3code.md`, `notes/gaps-ades.md` | Gap research against Tern, T3Code (commit 5f7294d) and other agent desktop apps. |
| `notes/t3code-thread-ui.md`, `notes/t3code-component-catalogue.md` | T3Code thread UI and component inventory with source references. |
| `notes/houston-orchestration-ui.md`, `notes/houston-visual-spec.md` | Inventory of Houston's current orchestration UI and visual tokens the mocks follow. |
| `refs/` | Captures of current Houston surfaces used as references (UI harness fixtures). |
| `threads-invariants.patch` | Draft rewrite of `AGENTS.md`, `docs/internals/invariants.md`, the glossary and `agent-lifecycle.md` for threads. Apply with `git apply` only together with the first implementation PR. |

## Decided (UX)

1. A thread is a pane type in the same split tree as terminal panes. No global mode switch.
2. The rail stays one card per grid; a grid with one thread plays the role of a T3Code thread.
3. Launcher A: `Ctrl+N` creates a grid with one thread of the default provider, named from the
   first prompt; `Ctrl+Shift+N` opens "New grid…" with agent chips, a Thread/Terminal toggle,
   checkout and "Customize each".
4. Continue, Wake and Reopen offer Thread or Terminal, while the agent is idle, by resuming the
   same provider session. Verified only for Claude and Codex.
5. Thread components are adapted from T3Code (catalogue in the mock, section "Componentes").
6. Orchestration in a thread follows the grid model: collapsed children strip, "N children" and
   Finished/Failed/Stopped rows, composer banners, opening a child swaps the pane content
   ("Orchestrator / child", Move to grid).
7. Attention rule: the parent orchestrator handles child questions first. The operator is alerted
   only on explicit escalation (`pane_escalate`) or by the safety net (the parent's authoritative
   turn end, or the parent closed or dead; quiet-settle does not count).

## Architecture

- **Verdict: A, provider adapters in the daemon** (T3Code model): Claude over its headless
  stream-json interface or Agent SDK, Codex app-server, ACP for Grok and Antigravity. Thread
  events use their own typed, coalesced channel and never touch `frame_queue`, `vt.rs` or the
  scrollback ring.
- **Rejected: B, a PTY bridge** (Tern-inspired): thread JSON would share the terminal byte path,
  the 4 MiB ring and the lossy frame queue.
- **Rejected: D, a conversation view built from hooks** (the remote companion feed, PR #92):
  it is a lossy projection of lifecycle events and answers prompts by keystroke automation.
  The feed stays what it is: a summary for the inbox and remote access.
- **Proposed shape for A:** one session model with two runtime kinds, so status, orchestration,
  sleep, restore, Tasks and Routines talk to the session, not to the PTY:

  ```rust
  enum Runtime {
      Pty(PtyRuntime),               // today's path, unchanged
      Structured(StructuredRuntime), // provider protocol adapter
  }
  ```

- **Acceptance criterion:** a new `perf_smoke` scenario. Terminal throughput and latency with
  threads streaming stay within the noise of the terminal-only baseline, on an idle machine.

## Open decisions

### Blocking

1. **Claude threads on a subscription.** Anthropic's documentation allows an end user to sign in
   to the unmodified Claude Code binary with their own subscription, which covers terminal panes.
   It also states that developers building products that interact with Claude, including through
   the Agent SDK, should use API key authentication, and that third-party developers may not
   route requests through Free, Pro or Max plan credentials on behalf of their users. Driving
   `claude -p` from the daemon is what the Agent SDK does internally, so the same rule likely
   applies. This is a reading of the documentation, not legal advice; confirm with Anthropic.
   Options: (a) Claude threads only with the user's own API key, kept in the OS keychain;
   (b) ask Anthropic for approval; (c) start threads with Codex, whose app-server is documented
   for "a deep integration inside your own product" (OpenAI's terms not yet reviewed), and keep
   Claude in terminal panes. Sources:
   [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
   [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
   [Codex app-server](https://learn.chatgpt.com/docs/app-server).
2. **The runtime refactor.** Introduce `Runtime::{Pty, Structured}` in the daemon, first with only
   `Pty` implemented and no behaviour change, verified by the full suites and `perf_smoke`.
   Needs explicit maintainer approval as a major refactor.
3. **Child permission authority.** Proposed: the parent never approves a permission in any launch
   mode; it may answer questions, deny or escalate, and only the operator approves. No provider
   reports whether a request is routine or dangerous, so any approval by the parent would rest on
   a classification Houston does not have. Prompt drafted for the orchestration work:

   ```
   Review accepted with one simplification: the parent never approves a permission, in any
   launch mode. It may answer questions, deny permissions, or escalate them; only the
   operator approves. This removes the need for any danger classification.

   - Auto child: any permission that reaches a prompt is blocked by definition.
   - --ask child: same rule; the parent filters and denies, every approval escalates.
   - Refuse pane_send_keys entirely while a permission episode is pending for that child,
     with an error naming the episode, the child and "use pane_deny or pane_escalate; only
     the operator may approve".
   - Add pane_deny (MCP + hs-pane): the daemon sends the provider's verified deny sequence.
     Providers without a verified sequence are refused by name. Resolution still waits for
     provider evidence.
   - Keep: bounded and redacted command/reason fields with an explicit "not reported by
     <provider>" state, an episode id separate from request_id, needs_input stays actionable
     for the parent, children_waiting counts only operator-owned episodes, safety net
     unchanged, Codex isolated events still non-alerting.
   - Protocol change: bump PROTOCOL_VERSION once, regenerate TS, update protocol.md, run
     check-protocol-sync.sh.
   - Integration tests: blocked permission -> parent inbox, no alert; escalate ->
     operator-owned + amber; parent authoritative turn end -> amber; pane_send_keys refused
     while pending; pane_deny resolves only on provider evidence; pane_deny refused for a
     provider without a verified sequence.
   Before coding, list the deny sequence per provider with the evidence you verified it from.
   ```

   `threads-invariants.patch` still describes the earlier asymmetric rule (the parent may approve
   routine requests from `--ask` children) and must be updated if this rule is accepted.

### Proposed defaults, to settle in the plan

- **Close, archive, delete:** closing stops the agent and keeps the conversation reopenable, in
  both surfaces; delete is explicit; archive comes later.
- **History:** "Reopen closed…" in the workspace `+` menu and command palette search first; a
  searchable history in the Overview later.
- **Children:** `pane_spawn` gains a `surface` argument, defaulting to terminal until the
  structured runtime is proven.
- **Scope:** Linux and Windows, local only; SSH refused by name. Deferred: importing existing
  sessions, fork and provider switch, checkpoints, per-worktree ports.
- **Rollout:** behind an experimental toggle until the performance and resume criteria pass.
- **Mobile:** PR #92 lands as is; the thread item schema later becomes a superset of its
  `FeedItem`, so the phone renders both.
- **Codex versions:** app-server schemas are specific to each Codex version and parts of the API
  are experimental; support a minimum version and refuse others by name.

## Suggested order

1. Spike with Claude and Codex on gaps 1 to 6 (invariants, provider contract, daemon process and
   state, one owner per session, streaming and performance, status source and MCP in structured
   mode), each with an acceptance test and a go/no-go outcome.
2. Minimum product: gaps 7, 8, 13 to 17, 24 and 25.
3. The remaining gaps in later phases.

## Prior art reviewed

- **BridgeMind One:** Code mode has Thread, Terminal, Files and Browser as pane types in one
  layout; thread adapters exist only for Claude Code and Codex. Closed panes' conversations stay
  reopenable from the `+` menu. ([docs](https://docs.bridgemind.ai/docs/code-mode),
  [changelog](https://www.bridgemind.ai/changelog))
- **Zed:** the Threads Sidebar lists ACP threads and Terminal Threads by project. Agent threads
  can be archived (not while running), restored with their worktree and deleted permanently;
  Terminal Threads are only closed and never enter the history.
  ([parallel agents](https://zed.dev/docs/ai/parallel-agents.html),
  [terminal threads](https://zed.dev/docs/preview/ai/terminal-threads.html))
- **Claude Code Remote Control:** the same local session in the terminal and in claude.ai or the
  Claude app at once, relayed through Anthropic; Claude only.
  ([docs](https://code.claude.com/docs/en/remote-control))
- **Happy:** a wrapper that switches a session between local terminal mode and remote mode,
  rather than showing both. ([repository](https://github.com/slopus/happy))
- **Tern:** the agent renders its own interface through an in-band protocol on the same PTY,
  with an ANSI fallback; only its own agent speaks the protocol.
