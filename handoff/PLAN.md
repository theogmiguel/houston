# Houston v2 plan: two maintainers, one PR

Theo and Augusto port T3 Code into Houston from separate machines and push to one `v2` branch,
reviewed as a single draft PR `v2 → main`. Read `HANDOFF.md` first for the decisions and research.

## Branches

- `v2` is the integration branch and the head of the draft PR. Nobody merges that PR alone.
- Each slice lives on a short branch `v2-<slice>` (for example `v2-contracts`, `v2-claude-adapter`; git cannot hold `v2/...` beside a `v2` branch),
  owned by one person, pushed to `origin` so the other can read it.
- A finished slice enters `v2` through a PR `v2-<slice> → v2`, merged with a merge commit after CI
  and review. Small direct pushes to `v2` (plan updates, `main` merges) pull first; if the push is
  rejected, pull and merge again. Never rebase or force-push `v2`.
- `main` is merged into `v2` (never rebased) once per release cut, by the person on integration duty
  that week. PR #368 (`feat/design-native`) is `v2`'s base: merge it into `main` soon, then into `v2`.

## Decisions

- **Copy, then adapt.** Upstream files are copied as they are and changed
  only where Houston differs: Electron → Tauri, names, Houston features. Workers adapt; they do not
  retype. A small diff against upstream keeps its later fixes easy to pull.
- **The server is detached.** Closing the app disconnects the client; threads and their agents keep
  running, as sessions do today. The server is not a plain Tauri sidecar (that dies with the app): the
  host spawns it detached, finds it through its state-directory lock, and reconnects.
- **Terminal: a drawer under the thread**, as upstream has it. The thread is the main surface; a
  shell PTY drawer sits below it with split, new and close. Agent CLIs no longer run in a terminal.
  The PTY side is ported with the server, the drawer with the renderer. A grid has at most one
  drawer open: opening another thread's drawer closes the previous one. Threads are the product;
  the drawer is secondary, keeps upstream's placement under its own thread, and comes after the
  thread timeline and composer.
- **Drawer rendering:** upstream's drawer (splits, persistent terminals, terminal context chips,
  links to the preview) is copied and adapted; inside it, Houston's terminal engine draws and
  carries the bytes (binary frames, bounded buffers, measured on WebKitGTK and Windows), through an
  adapter. Both use libghostty-vt; upstream's wrapper was never run on WebKitGTK.
- **The renderer is upstream's `apps/web`, copied**, running in Houston's Tauri webview (React and
  TypeScript, as `ui/` is today; Rust stays the host). From Houston it keeps only the sidebar
  (workspaces → grids → threads), the grid split tree and the terminal engine. PR #368's design
  carries over through tokens, not per component: upstream's theme variables in `index.css` map to
  Houston's tokens, and upstream's ~46 primitives in `components/ui` adopt #368's recipes. Feature
  components inherit the look unchanged. Houston's style guards bind the primitives and the kept
  Houston parts; copied feature components are exempt until a slice adapts them.
- **Browser: upstream's.** v2 ports upstream's preview on its server engine: headless Chromium
  (`chrome-headless-shell`, downloaded with a pinned checksum) driven over CDP and streamed as a
  JPEG screencast. Houston's native browser and its `browser_*` MCP tools are dropped with v1.
  Electron-only features (element picker, favicons, cookie import, passkeys) do not come over. The
  browser slice decides whether agent actions keep Houston's on-screen confirmation, which upstream
  lacks, and states the Linux runtime libraries and AppArmor profile the download needs.
- **PR #117 (WSL on `houston-core`) is paused.** WSL returns as a server slice.
- **Slices merge through mini-PRs** `v2-<slice> → v2`, each with CI and the other maintainer's review.
- **v1 is frozen to fixes.** After PR #368, `main` takes bug fixes only; new features go to v2.
  Each `main` change must later be merged into `v2`, which removes the code those changes touch.
- **PR #368 merges into `main` first**, then `main` into `v2`, so the v2 PR does not carry the
  redesign's diff. #368 is red (`safety-checks`, `windows-checks`, `windows-renderer-checks`); Theo
  fixes it before anything else.

## Licence

- Commit 0 on `v2` adds T3 Code's MIT notice to `NOTICE` and `third-party-licenses.config.json`,
  pinned at upstream commit `9826dbb9`. No ported code was pushed before it.
- `upstream.json` at the root records the upstream commit and the imported and excluded paths.
  Files carry no per-file header, so an unadapted file stays byte-identical to upstream and later
  fixes come over as a diff between pinned commits.
- The Claude Agent SDK ships under Anthropic's own terms, not MIT. Read them before the Claude adapter
  slice decides between the SDK and the CLI's stream-json protocol.

## Split

The two halves meet at `packages/contracts` (the server ↔ renderer RPC schemas). **Augusto owns the
server; Theo owns the Tauri host and the renderer.** Each one reviews the other's slices.

### Augusto: server

Everything under the TypeScript sidecar, in this order:

1. `contracts` and the shared packages, plus the server's directory layout. Theo reviews before it
   merges, since the renderer builds on it. Includes the binary frame format for terminal bytes
   (reusing `houston-protocol`'s framing and its bounded buffers).
2. Persistence: event store, projections, migrations, outbox, command receipts.
3. Provider core and the Claude adapter. First read the Claude Agent SDK terms and decide SDK versus
   the CLI's stream-json protocol; PR #363 already implements the latter.
4. Codex, OpenCode and ACP adapters, and the terminal PTY service behind the drawer.
5. orchestration-v2 (replaces `pane_*`).
6. Git, pull requests, worktrees, checkpoints, usage.
7. MCP toolkits (the orchestration tools agents call).
8. Server side of the Houston-only features: Night shift, task sources (GitHub, Notion, Slack),
   workspace transfer, WSL. Each is decided (port, adapt or drop) when its slice starts.

Also Augusto's: the decision on PR #363 (close it, or name what v2 reuses from it).

### Theo: host and renderer

Everything in `src-tauri` and `ui/`, in this order:

0. Fix PR #368's CI and merge it into `main`, then `main` into `v2`.
1. The `v2-checks` CI workflow. It exists with doc hygiene outside `handoff/` and the licence
   notice gate; each slice adds its own job (server tests, sidecar build), and the `ci.yml` jobs
   for `houston-core` are dropped when the daemon is removed.
2. Server host: bundled runtime; spawn the server detached so it outlives the app, reusing
   `daemon_host.rs`'s spawn path; on Windows also break away from any job object the app runs in
   (`CREATE_BREAKAWAY_FROM_JOB`, with a fallback when the job forbids breakaway); find it through
   its state-directory lock; health check, restart, logs, reconnect; keychain, tray and updater
   kept working against the new server.
3. Copy upstream's `apps/web` in as the renderer, building inside the Tauri webview.
4. Re-skin: map upstream's theme variables to Houston's tokens and adapt its primitives to #368's
   recipes (type scale, radius roles, `StatusGlyph`, buttons, rows, menus); review the result with
   the `apple-design` skill in both themes.
5. Houston's sidebar and grid split tree in upstream's app shell: workspaces → grids → several
   threads per grid.
6. The terminal drawer on Houston's terminal engine.
7. Browser: upstream's preview panel on its server engine.
8. Renderer side of the Houston-only features, after Augusto's matching server slice.

Until Augusto's `contracts` slice lands, Theo works on items 1–2 and the re-skin, which do not
depend on it.

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
  worktrees. Only `v2-*` branches are shared.

## Done for a slice

1. The slice's upstream tests are ported first and pass.
2. The other maintainer reviews a sample of the ported code.
3. The v2 gate passes at the merge into `v2`.

## Open decisions

0. Server runtime, decided together: Node or Bun. The drawer's PTY uses `node-pty`, a native
   addon, and upstream runs its server on Node (`engines.node >=22.16`). Theo recommends Node: it
   is what upstream and `node-pty` are tested on, at the cost of bundling a Node binary.

1. PR #363 and the Claude adapter's base (Agent SDK or CLI stream-json, given the subscription
   policy): Augusto's call, early in his slice 3.