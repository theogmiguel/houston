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
- **Upstream's features as they are.** v2 takes upstream's orchestration, settings and other
  features unchanged and adjusts them later; Houston-only features wait until the port is complete.
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
   workspace transfer, WSL. Deferred until the port is complete; each is then ported onto the v2
   stack when its slice starts (see "v1 removal").

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
8. Renderer side of the Houston-only features: deferred with the server side.

Until Augusto's `contracts` slice lands, Theo works on items 1–2 and the re-skin, which do not
depend on it.

### Shared

- `contracts` after its first slice: either maintainer may change it, in a small separate commit
  announced to the other before pushing.
- Integration duty (merging `main` into `v2`) alternates weekly, starting with Theo.
- `AGENTS.md`: Augusto writes the v2 invariants for the server, Theo for the host and renderer,
  when their architecture lands.

### v1 removal

The daemon (`houston-core`) and Houston's MCP orchestration (`pane_*`, `hs-pane`) leave with v1;
agents orchestrate through upstream's orchestration-v2.

**The T3 base comes first.** The Houston-only ports were parked and now return one by one on the
v2 server while the T3 base finishes in the renderer and the bridge: the Tasks agent toolkit
(#456), merge queue hand-off and stacks (#469), harness review (#450), Slack intake (#459),
workspace transfer (#470) and Night shift (#471). Each parked PR is a draft titled "Parked:" that
holds its work so far, and a maintainer reviews it before it merges. Houston code already on `v2`
stays: the server entrypoint, provider status, send intents, reviewed files, aside and second
opinion, the Tasks backlog store and runs, task sources sync and writeback (#457), and the merge
queue core.

So `core/` is removed now, without waiting for the ports, in two PRs. The PR that deletes a path
also removes every reader of it, so `v2` builds at every merge:

1. **PR A (Theo), first:** the utilities `src-tauri` still takes from `houston_core` move to
   `src-tauri/src/sys/`; the v1 host path goes (`daemon_host`, `daemon_isolation`, the supervisor,
   the native browser, the webview spike and bench, the v1 parts of host, tray, wsl and app_update,
   the `hook`/`hs-pane`/`hs-mail` dispatch, `HOUSTON_V1_HOST`, `externalBin` and the WSL bundle);
   and `ui/` goes with its readers (the v1 renderer CI jobs, its scripts, its licence graph). After
   it, `src-tauri/Cargo.toml` depends on neither `houston-core` nor `houston-protocol`. The
   renderer-freeze watchdog is fed only by `ui/`'s paint reports, so it is either wired to
   `apps/web` or removed with `ui/`.
2. **PR B (Augusto, Theo reviews), on top of PR A:** a one-time `v1_cleanup` in the host removes
   Houston's managed hook and MCP blocks from the agent CLIs' configs (it stands down while a v1
   daemon of the same channel runs; the host never stops a v1 daemon); `core/`, `protocol/`,
   `packages/contracts/src/houston/terminalFrames.ts` and everything that reads them are deleted; the docs are rewritten and `AGENTS.md` gets the v2 invariants. `native/libghostty-vt`
   stays: the v2 terminal drawer builds its WASM from it.

A v1 user loses the parked features until they return, and the features with no port planned
(remote access, dictation, review tiers, SSH panes, skill sync, conflict prediction, WSL). v1's data
in `~/.houston*` is never deleted or opened read-write; v2 keeps its state in `<channel dir>/v2`.

Before `handoff/` is deleted, `handoff/design/`'s boards and `read-board.py` move to
`apps/web/design/`, and its rules and decisions into `docs/internals/styleguide.md`.

### Additions from MonoCode and Capy

Designed on the "Additions" page of the v2 design canvas. Each starts after the parity slices it
builds on. MonoCode is MIT: code copied from it adds its notice to `NOTICE` and
`third-party-licenses.config.json` first, like upstream's. Capy is closed source; only its
behaviours are taken.

New slices:

- **Quick composer** (Theo, after renderer item 5). A system-wide shortcut, Ctrl Shift Space by
  default and changeable in Settings → Keyboard, opens a small Tauri window that starts a thread in a
  chosen project and grid on the detached server. It closes only when the server accepts the thread;
  a refusal keeps the draft. Wayland compositors that refuse global shortcuts are named in Settings,
  and the tray's "New thread…" opens the same window. Reference: MonoCode `src/features/quick-composer`.
- **Aside and second opinion** (server: Augusto, after server item 4; renderer: Theo). An aside is a
  read-only side conversation about a thread in a right-panel tab; it never interrupts the run.
  A second opinion asks another provider to review one turn and its diff; the result enters the
  thread only through Send to thread, which queues it as the next message. Each adapter declares
  whether it offers an isolated read-only run; providers without one are refused by name.
  Reference: MonoCode `src/features/sessions/model/btw.ts` and `secondOpinion.ts`.
- **Provider status** (server: Augusto, in provider core; renderer: Theo). Each provider reports one
  state with its cause — not installed, turned off, signed out, rejected by the provider (with its
  code), out of usage until a named reset, ready — and the renderer shows the one action that
  resolves it in Settings, first run, the model picker and the stopped thread.

Folded into existing slices:

- **Usage page** (renderer item 4). Upstream's usage route, banners and thread-details rows are kept
  as they are and only re-skinned: Houston's column and type, neutral bars that read as room left,
  amber at 20% and red at 10% with the number recoloured too.
- **Read means seen** (renderer item 5). A thread's unread mark clears only while its window is
  visible and focused and its timeline is at the end.
- **Reviewed files follow the commit** (server item 6 and its renderer). A viewed mark belongs to one
  head SHA; new commits clear the marks of the files they touch, and comments whose lines moved
  show as outdated.
- **Send intents** (server item 5 and the composer). Queue, steer and interrupt each say when the
  agent reads the message; steer delivery is not shown as adoption.
- **Reconnect** (host item 2). Exponential backoff with full jitter from 0.5 s to 30 s; a version
  mismatch or a refused token stops retrying and names the cause.

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