# Houston contributor instructions

Houston is a local-first desktop application for coding agents on Linux and Windows. A
Tauri host starts, or attaches to, a detached TypeScript server for its channel; the
renderer presents each agent conversation as a **thread**. Closing the application detaches
the client; the server and its agent runs continue. The server is ported from the upstream
project named in [NOTICE](NOTICE).

## Branch `v2`

`v2` and its `v2-*` slice branches carry the rebuild. `handoff/` holds the decisions and the
slice plan; read `handoff/HANDOFF.md` and `handoff/PLAN.md` before starting a slice.

- **Tests first:** a slice ports its upstream tests before its code and lands only with
  them green.
- **Shared branch:** `v2` has two maintainers pushing from separate machines. Never
  rebase or force-push `v2`; slices enter through PRs `v2-<slice> → v2`. Regenerate lockfiles
  and the licence inventory instead of hand-merging them.
- `check-doc-hygiene.sh` fails on `handoff/` by design; `handoff/` is deleted before `v2`
  merges into `main`.

Prefer the smallest design that satisfies the requirement. Verify documentation against
the implementation and correct discrepancies in the same change. If an instruction
conflicts with the task, explain the conflict and obtain maintainer direction.

## Invariants

- **Detached server** (`apps/server`): closing the app stops neither the server nor its agent
  runs. One server runs per channel; clients find it through
  `<channel dir>/v2/userdata/server-runtime.json`.
- **Local state** (`<channel dir>/v2`): one user, one machine, one SQLite database per channel.
  Upstream's tables follow upstream's migrations; Houston's tables live on the Houston migration
  track (`houston_sql_migrations`), whose ids never enter upstream's migrator. Houston has no
  telemetry service: analytics and every OTLP export are off by construction, and no setting or
  environment variable turns them on. Local-first does not mean offline: a network-backed feature
  states what it transmits and when. Updates require an explicit user action.
- **v1 state** (`~/.houston`): v2 never deletes, moves or opens v1's state read-write. A one-time
  import reads v1's `houston.db` read-only. The host's one v1 cleanup reads the channel
  directory and edits only the agent CLI configs v1 changed.
- **Reported status** (provider adapters): agent status comes from each provider adapter's
  structured stream (SDK, app-server, server or ACP events), never from terminal output.
- **Orchestration** (orchestration-v2): agent-to-agent work uses upstream's orchestration-v2 and
  the server's MCP toolkits. A credential carries only the capabilities its thread needs: a
  read-only thread runs with the provider's own read-only sandbox, no user MCP servers, and no
  MCP credential beyond the operations it must submit.
- **Contracts** (`packages/contracts`): every server ↔ renderer message is typed there. Houston
  additions live under `houston/` and use `houston.*` RPC names. A new WebSocket method is listed in
  `RpcInstrumentation.ts` and given a scope in `RpcAuthorization.ts`.
- **External configuration** (managed-marker): changes to an agent CLI's configuration are
  reversible managed-marker blocks. `~/.claude.json` is never rewritten; it changes only through
  `claude mcp`.
- **Secrets** (keychain): tokens live in the OS keychain, scoped by channel directory, project and
  provider, never in the database, logs, traces, errors, RPC replies or stream events. A token is
  bounded in size and refused by name above the bound.
- **Untrusted input**: text from outside (GitHub, Notion, Slack, imported files) is bounded,
  attributed and kept from acting as instructions before it reaches a prompt; text Houston sends
  out is escaped so it cannot mention, link or close anything it did not mean to.
- **Copy, then adapt** (`apps/server/src/houston`): Houston code lives under `houston/`
  directories. Upstream files are copied as they are and changed only where Houston differs; every
  changed file is listed in `upstream.json` `adapted` with its reason, in the same PR. Ported code
  is pushed only with the MIT notice in `NOTICE` and `third-party-licenses.config.json`.

<!-- Host and renderer invariants (Theo): the Tauri host, the desktop bridge, the renderer
     base and style guards, the terminal drawer. Until then the rule below stands. -->

- **Renderer:** the upstream web app is the renderer base. Its primitives adopt Houston's
  tokens and recipes and are bound by the style guards; copied feature components are exempt
  from the feature-`className` rule until a slice adapts them.

## Terms

Use the [glossary](docs/internals/glossary.md) consistently:

- **Contributor agent:** the agent editing Houston. Contributor agents run in the installed
  release built from `main`; check `HOUSTON_SESSION` before operations that could affect the
  pane hosting it.
- **Server:** the TypeScript server under `apps/server`, upstream's with Houston's additions, run
  detached by the host for one **channel**. The installed `release` channel keeps its state in
  `~/.houston/v2`; `dev` uses `~/.houston-dev/v2`.
- **Thread:** a structured conversation with one agent. A **turn** is one request and its answer;
  a **run** is the provider session that serves a thread.
- **Side thread:** a read-only thread beside another one (an aside, a second opinion, a task
  planner or reviewer). It never writes to its source.
- **Orchestration:** agent-to-agent work through orchestration-v2 (`delegate_task`, subagents) and
  the server's MCP toolkits.
- **Houston migration track:** Houston's own migration table and ids, applied after upstream's.

<!-- Host and renderer terms (Theo): workspace, grid, drawer and renderer terms. -->

## Safety boundaries

1. **Identify processes by channel.** Stop a server only by the PID its channel's
   `server-runtime.json` names. Never use `pkill -f`, `pgrep | kill`, or a PID chosen by matching a
   name, path or parent PID. Host code signals processes only through `crate::sys::pid`;
   non-positive PIDs can broadcast signals, and casting `u32::MAX` to `pid_t` produces -1.
2. **Protect installed state.** Never point a development server at `~/.houston` or
   `~/.houston/v2`, and never open v1's database read-write. `--channel release` requires
   explicit instruction. Tests use temporary directories and never the real home.
3. **One server per channel.** Preserve upstream's server ownership lock; a second server for the
   same base directory exits instead of sharing its database.
4. **Never touch the host keyring.** Server tests use the in-memory keychain layer; only
   `server.ts` provides the live one. Do not run `gnome-keyring-daemon` (least of all
   `--unlock`) on the host: it re-encrypts the user's real login keyring and locks them out.
   Host tests that need a Secret Service run through `scripts/with-test-keyring.sh`.
5. **Never touch the user's repositories by accident.** Server git commands that act for the
   user neutralise user configuration that could reach refs outside their own worktree
   (`rebase.updateRefs`, `push.followTags`, hooks, signing, submodule recursion), push only with a
   lease to branches the server owns, and leave the user's checkout byte-identical.

## Cross-surface checklist

Before completing a change, identify which of these checks apply:

- **Upstream drift:** `node scripts/check-upstream.mjs <upstream clone> --skip apps/web` exits 0.
  The clone is checked out at `upstream.json`'s `commit`; CI reads the same commit.
- **Migrations:** a Houston migration takes the next free id on the Houston track, and PRs that
  carry Houston migrations merge in id order (the migrator skips ids below the highest recorded).
- **Providers:** support each provider for a feature or refuse it by name; a refusal names the
  provider and the missing capability.
- **State transitions:** provide reversal and visibility, and settings with a visible current
  value. Errors for limits name the limit, actual value and requested operation.
- **Platforms:** Linux and Windows are supported release platforms. A platform-specific behaviour
  has an equivalent elsewhere or a named limitation.
- **Network:** a feature that sends anything off the machine lists each call, its cadence and its
  limits, and sends nothing while disabled.
- **Documentation:** describe user-visible behaviour in the PR title used for release
  notes. Update the relevant `docs/user/` page when usage changes.

<!-- Host, renderer and installer items (Theo). -->

## Development and verification

The [development runbook](docs/operations/development.md) contains exact commands.

- The server package is `houston`: run its tests with
  `pnpm --filter houston exec vp test run <files>`. A filter that matches no package exits 0 without
  running anything, and so does a `-t` pattern that matches no test, so confirm with
  `--reporter=verbose` that a proof ran.
- Tests come before code, and a bug fix has a regression test that fails before the fix. Fixtures
  represent states the system can produce; composed fixtures are labelled as composed.
- Server code that reaches a provider, GitHub, Notion, Slack or the keychain is tested against
  replay fixtures, local fakes and the in-memory keychain, never the real service.
- A change to an adapted upstream file is minimal: no unrelated reformatting.
- For host changes, run `cargo fmt`, `cargo clippy --all-targets -- -D warnings` and
  `cargo test` in `src-tauri` (it embeds the `@t3tools/web` build, so build that first). On
  Linux, run heavy builds under `scripts/oom-shield.sh`, with `nice -n 19` and `-j 3`. On
  Windows, limit Cargo to three jobs. Never run concurrent Cargo workloads.
- Diagnose failures using the discriminator appropriate to the failure mode in
  [testing](docs/internals/testing.md); a standalone rerun is not sufficient for every case.
- Push and PR CI runs `safety-checks`, `linux-native-checks`, `windows-checks` and `licence-inventory`;
  Contributors still run the full suites locally before every push. `v2-checks.yml` runs the
  workspace suites, the web build and the upstream drift check.

## Pull requests and releases

- All changes to `main` go through a PR, including documentation. Merge only with green
  CI and completed local gates. Do not assume branch protection is configured; verify
  repository settings when administering it.
- Use conventional PR titles that describe user-visible behaviour, for example
  `fix(threads): a renamed thread keeps its name after a restart`. Release notes group the
  items in each PR's `## Release notes` section; legacy titles are a fallback. Use
  explicit `None` for internal-only changes. See the release runbook for categories.
- Explain the problem and resulting change in the PR body. Omit generated-by footers
  and agent session links. Keep one concern per commit. Destructive Git operations
  require explicit authorization.
- Only a release changes versions. Feature PRs must not edit the three version manifests.
  The manually dispatched **Cut release** workflow uses `scripts/set-version.sh` to update
  the three manifests and `src-tauri/Cargo.lock`, commit, tag, build and create a draft
  release. Stable cuts require the tip of `main`, an unused tag and a version newer than the
  last stable release. See the [release runbook](docs/operations/release.md).
- A manually pushed `v*` tag starts no workflow; releases are produced only by **Cut
  release**. `build-installers.yml` builds selected OSes (both by default) and files nothing.

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

The server owns threads and agent runs independently of connected clients. See the
[architecture overview](docs/internals/overview.md).

- `apps/server`: the server; Houston's additions under `src/houston/`.
- `apps/web`: the renderer.
- `packages/contracts`: the server ↔ renderer schema; Houston's under `src/houston/`.
- `packages/*`: upstream's provider, source-control and shared packages.
- `src-tauri`: the desktop host, server supervision, desktop bridge and tray; host utilities
  under `src/sys/`.
- `scripts/`: development, build, installation and safety checks.
- Keep provider complexity at provider boundaries, server models testable and renderer
  logic focused on presentation. Change only what the task requires.
- Comments explain non-obvious usage and follow the comment hygiene budget. Tunable
  constants need a short rationale; measure when their values affect performance.
- Errors include the offending value and expected shape. Avoid unrelated product names
  in code and comments; document the technical constraint instead.
- Follow the [style guide](docs/internals/styleguide.md).

<!-- Renderer composition and capture rules (Theo). -->
