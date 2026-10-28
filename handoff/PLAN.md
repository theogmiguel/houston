# Houston v2 plan: two maintainers, one PR

Theo and Augusto port T3 Code into Houston from separate machines and push to one `v2` branch,
reviewed as a single draft PR `v2 → main`. Read `HANDOFF.md` first for the decisions and research.

## Branches

- `v2` is the integration branch and the head of the draft PR. Nobody merges that PR alone.
- Each slice lives on a short branch `v2/<slice>` (for example `v2/contracts`, `v2/claude-adapter`),
  owned by one person, pushed to `origin` so the other can read it.
- A finished slice enters `v2` with `git merge --no-ff v2/<slice>` and a push. Pull first; if the
  push is rejected, pull and merge again. Never rebase or force-push `v2`.
- `main` is merged into `v2` (never rebased) once per release cut, by the person on integration duty
  that week. PR #368 (`feat/design-native`) is `v2`'s base: merge it into `main` soon, then into `v2`.

## Licence

- Commit 0 on `v2` adds T3 Code's MIT notice to `NOTICE` and `third-party-licenses.config.json`,
  pinned at upstream commit `9826dbb9`. No ported code was pushed before it.
- Every ported file starts with a header naming the upstream path and commit, so upstream fixes can
  be found later with a diff between pinned commits.
- The Claude Agent SDK ships under Anthropic's own terms, not MIT. Read them before the Claude adapter
  slice decides between the SDK and the CLI's stream-json protocol.

## Split

The two halves meet at `packages/contracts` (the server ↔ renderer RPC schemas). **Augusto owns the
server; Theo owns the Tauri host and the renderer.** Each one reviews the other's slices.

### Augusto: server

Everything under the TypeScript sidecar, in this order:

1. `contracts` and the shared packages, plus the server's directory layout. Theo reviews before it
   merges, since the renderer builds on it.
2. Persistence: event store, projections, migrations, outbox, command receipts.
3. Provider core and the Claude adapter. First read the Claude Agent SDK terms and decide SDK versus
   the CLI's stream-json protocol; PR #363 already implements the latter.
4. Codex, OpenCode and ACP adapters.
5. orchestration-v2 (replaces `pane_*`).
6. Git, pull requests, worktrees, checkpoints, usage.
7. MCP toolkits (the orchestration tools agents call).
8. Server side of the Houston-only features: Night shift, task sources (GitHub, Notion, Slack),
   workspace transfer, WSL. Each is decided (port, adapt or drop) when its slice starts.

Also Augusto's: the decision on PR #363 (close it, or name what v2 reuses from it).

### Theo: host and renderer

Everything in `src-tauri` and `ui/`, in this order:

1. The `v2-checks` CI workflow, and which `ci.yml` jobs it replaces on `v2`.
2. Tauri sidecar supervisor: bundled runtime, start, health check, restart, logs; keychain, tray,
   updater and native browser kept working against the new server.
3. Thread pane mock in `mocks/houston-mocks.html`, then the A/B picks still open in the other
   fragments.
4. Thread timeline: virtualized list, scroll anchoring and follow, incremental markdown, work groups.
5. Composer: queue, steer and interrupt intents, approvals, questions, attachments.
6. Sidebar: workspaces → grids → threads, with grids of several threads.
7. Settings and the remaining pages (Tasks, Routines, PRs, Usage, Changes) on the new server.
8. Renderer side of the Houston-only features, after Augusto's matching server slice.

Until Augusto's `contracts` slice lands, Theo works on items 1–3, which do not depend on it.

### Shared

- `contracts` after its first slice: either maintainer may change it, in a small separate commit
  announced to the other before pushing.
- Integration duty (merging `main` into `v2`) alternates weekly, starting with Theo.
- `AGENTS.md`: Augusto writes the v2 invariants for the server, Theo for the host and renderer,
  when their architecture lands.

## Coordination

- One GitHub issue per slice, label `v2`, assigned to its owner. Assignment is the lock: do not start
  an unassigned slice or one assigned to the other person.
- The draft PR body carries the slice checklist and its status.
- When a slice merges into `v2`, its owner updates the slice's line in this file.
- Shared files have fixed rules:
  - `bun.lock` and `Cargo.lock`: never hand-merge; take one side and regenerate.
  - New dependencies: one commit of their own, then regenerate the licence inventory with
    `node scripts/gen-third-party-licenses.mjs`.
  - `AGENTS.md` and `handoff/`: announce before editing.
- Workers (opencode panes on DeepSeek 4.1) run on each maintainer's own machine, in their own
  worktrees. Only `v2/*` branches are shared.

## Done for a slice

1. The slice's upstream tests are ported first and pass.
2. The other maintainer reviews a sample of the ported code.
3. The v2 gate passes at the merge into `v2`.

## Open decisions

1. Slice merges: direct `--no-ff` merges into `v2` (above), or mini-PRs `v2/<slice> → v2` for
   cross-review and per-slice CI. Decide together before the first slice merges.
2. PR #363: Augusto's call (see his list).
