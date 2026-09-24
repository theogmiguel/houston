# Houston contributor instructions

Houston is a local-first, Linux-first desktop application for CLI coding agents. A Tauri
client connects to a detached Rust daemon that owns real PTYs in project directories.
The renderer presents sessions as terminal panes. Closing the application detaches the
client; the daemon and its sessions continue running.

Prefer the smallest design that satisfies the requirement. Verify documentation against
the implementation and correct discrepancies in the same change. If an instruction
conflicts with the task, explain the conflict and obtain maintainer direction.

## Invariants

- **Terminal fidelity:** panes are real PTYs rendered with libghostty-vt. Preserve input
  delivery; do not replace terminal interaction with chat wrappers or transcript scraping.
- **Reported status:** use CLI lifecycle hooks or supported ACP streams for agent status.
  Do not infer status from terminal pixels or text. Exceptions are explicitly documented
  in [invariants](docs/internals/invariants.md).
- **Local state:** one user, one machine, one SQLite database per channel. Houston has no
  telemetry service. Local-first does not mean offline: hosted agent CLIs and optional
  network-backed features must state what they transmit and when. Updates require an
  explicit user action. Store secrets in the OS keychain, never in the database or logs.
- **Bounded work:** use binary PTY frames and bounded buffers. Keep JSON and continuous
  animation off the terminal rendering hot path; verify performance with measurements.
- **External configuration:** changes to agent CLI configuration must use reversible
  managed-marker blocks. Never manually rewrite `~/.claude.json`.

## Terms

Use the [glossary](docs/internals/glossary.md) consistently:

- **Contributor agent:** the agent editing Houston. Check `HOUSTON_SESSION` before
  operations that could affect the pane hosting it.
- **Agent:** a coding CLI hosted by Houston. A **session** is its PTY (or a shell PTY);
  a **pane** is the corresponding cell in the renderer grid.
- **Workspace:** a project directory known to the daemon. Sessions belong to a workspace.
  A **grid** is a named layout; its split tree lives in renderer `localStorage`, not the
  database or wire protocol.
- **Daemon:** `houston-core`, which owns PTYs, storage, hooks and MCP for one **channel**.
  The installed `release` channel uses `~/.houston`; `dev` uses `~/.houston-dev`.
- **Hooks:** CLI lifecycle events delivered as drop files and applied by the daemon.
- **Orchestration:** agent-to-agent operations through `pane_*` MCP tools or `hs-pane`.
  Each signal is one inbox row, delivered through `pane_wait`, a Stop hook or a paste.

## Safety boundaries

1. **Identify processes by channel.** Never use `pkill -f`, `pgrep | kill`, or a PID
   selected by matching a name or path. Confirm the target channel and use its
   `daemon.json` PID. Production code must use `houston_core::pid` for `kill(2)`;
   non-positive PIDs can broadcast signals, and casting `u32::MAX` to `pid_t` produces -1.
2. **Protect installed state.** Never start a development daemon against `~/.houston`,
   open its database read-write, or clean that directory. `--channel release` requires
   explicit instruction. Installed binaries under `~/.local/lib/houston/` must remain
   independent of the checkout; preserve `install-desktop.sh`'s repository-path refusal.
3. **One daemon per state directory.** Preserve the advisory `daemon.lock`: competing
   daemons would overwrite discovery state and share a database. Restart development
   through `scripts/dev.sh --fresh`, which refuses to restart its own hosting channel.

## Cross-surface checklist

Before completing a change, identify which of these checks apply:

- **Host:** `core/houston-core/src/main.rs` starts background loops through `boot.rs`.
  The app's `daemon_host.rs` connects or spawns a detached daemon (through
  `houston-supervisor` on Linux). The app must never invoke daemon boot loops;
  `check-loop-spawn-sync.sh` enforces this boundary.
- **Transport:** control JSON and binary PTY frames share the authenticated `/ws`
  connection in the app, other clients and tests. Terminal-byte features use `server.rs`.
- **Providers:** Claude, Codex, Antigravity, OpenCode, Cursor and Grok have distinct launch
  and hook installation paths. Support each relevant provider or refuse it by name.
  Droid, Copilot and Aider are recognised identities only; they are not spawnable.
- **Protocol:** type all `/ws` messages in `core/houston-protocol`. Bump
  `PROTOCOL_VERSION` once per wire-changing batch, regenerate TypeScript and update
  `protocol/protocol.md` in the same commit. Run `check-protocol-sync.sh`.
- **State transitions:** provide reversal and visibility: spawn/kill, pin/unpin, and
  settings with a visible current value. Errors for limits name the limit, actual value
  and requested operation.
- **Platforms:** Linux is the primary platform; Windows uses ConPTY and NSIS. Every
  platform-specific behaviour needs an equivalent or an explicit refusal elsewhere.
- **Documentation:** describe user-visible behaviour in the PR title used for release
  notes. Update the relevant `docs/user/` page when usage changes.

## Development and verification

The [development runbook](docs/operations/development.md) contains exact commands.

- `scripts/dev.sh` builds the renderer and debug app on the dev channel. There is no HMR;
  rebuild after changes. Live-test daemon changes with `scripts/dev.sh --fresh`.
- Run heavy builds under `scripts/oom-shield.sh`, with `nice -n 19` and `-j 3`.
  Never run concurrent Cargo workloads. Run `perf_smoke` at normal priority on an idle
  machine; results obtained under load do not establish a performance regression.
- Agent worktrees under `.houston/worktrees/` build the dev profile only, never
  `--release`. Remove a worktree once its branch is integrated; `scripts/sweep-targets.sh`
  bounds what remains (see the runbook's disk usage section).
- For each change, run `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, relevant
  test binaries and safety scripts in the affected crate. For renderer changes, run
  `bun run typecheck` and affected tests.
- At integration boundaries and before every push, run the full suites under the memory
  guard. Run renderer checks in the documented order: `check:css` and `check:bundle`
  consume build output. Use `bun run test`; `bun test` is a different runner.
- New daemon behaviour requires an integration test in `core/houston-core/tests/`.
  Bug fixes require a regression test that fails before the fix. Fixtures must represent
  states the system can actually produce.
- Diagnose failures using the discriminator appropriate to the failure mode in
  [testing](docs/internals/testing.md); a standalone rerun is not sufficient for every case.
- Push and PR CI runs `safety-checks`, `renderer-checks`, `core-checks` and
  `licence-inventory`. Contributors must also run the local integration suites.

## Pull requests and releases

- All changes to `main` go through a PR, including documentation. Merge only with green
  CI and completed local gates. Do not assume branch protection is configured; verify
  repository settings when administering it.
- Use conventional PR titles that describe user-visible behaviour, for example
  `fix(panes): a renamed pane keeps its name across respawn`. Release notes list merged
  PR titles. Documentation-only and CI-only PRs need not use a user-facing description.
- Explain the problem and resulting change in the PR body. Omit generated-by footers
  and agent session links. Keep one concern per commit. Destructive Git operations
  require explicit authorization.
- Only a release changes versions. Feature PRs must not edit the four version manifests.
  The manually dispatched **Cut release** workflow uses `scripts/set-version.sh` to update
  all four manifests and both lockfiles, commit, tag, build and create a draft release.
  Stable cuts require the tip of `main`, an unused tag and a version newer than the last
  stable release. See the [release runbook](docs/operations/release.md).
- A manually pushed `v*` tag starts no workflow; releases are produced only by **Cut
  release**. `build-installers.yml` builds both OSes and files nothing.

## Documentation

Use professional, concise English in all documentation, including Markdown and text files.
Explain constraints and usage; avoid personal narrative, unsupported claims and repetition.

- `docs/user/`: task-oriented guidance for application users. Include relevant settings
  paths; omit implementation details and descriptions of individual visual controls.
- `docs/internals/`: architectural constraints, rationale and non-obvious implementation
  risks. Do not duplicate field lists, control flow or file inventories. Rewrite obsolete
  constraints instead of appending a competing account.
- `docs/operations/`: maintainer runbooks for development, releases and the Linux testbed.
- Keep documentation within the established tree. Do not add per-feature Markdown,
  per-crate pages or notes files. `check-doc-hygiene.sh` also rejects diary content,
  dates, phase numbering, session narrative and unrelated product references in docs.
- Add new vocabulary to the glossary. A merged PR is the implementation record; do not
  commit plans, research, audits, scratch files or completed implementation checklists.
  Keep working material outside the tracked tree.
- Track work in GitHub issues and proposals in Discussions, following
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture and style

The daemon owns sessions independently of connected clients. Control-plane events and
detach drive persistence; terminal bytes use binary frames. Agent orchestration uses MCP
on the daemon port with per-pane bearer tokens. See the
[architecture overview](docs/internals/overview.md).

- `core/houston-protocol`: Rust wire schema and generated TypeScript source types.
- `core/houston-core`: daemon, PTYs, persistence, hooks, orchestration and provider logic.
- `src-tauri`: desktop application, daemon connection, native browser, watchdog and tray.
- `ui/src/renderer/src`: React renderer, terminal engine, layout, components and transport.
- `scripts/`: development, build, installation and safety checks.
  `protocol/protocol.md`: protocol reference.
- Keep provider complexity at provider boundaries, core models testable and renderer
  logic focused on presentation. Change only what the task requires.
- Comments explain non-obvious usage and follow the comment hygiene budget. Tunable
  constants need a short rationale; measure when their values affect performance.
- Errors include the offending value and expected shape. Avoid unrelated product names
  in code and comments; document the technical constraint instead.
- Follow the [style guide](docs/internals/styleguide.md): theme tokens, shared chrome
  constants, `Tooltip` instead of `title`, and `Select` instead of native `<select>`.
