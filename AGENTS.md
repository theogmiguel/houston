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
- **Migrations:** a Houston migration takes the next free id on the Houston track. The Houston
  runner applies every id a database has not recorded, in ascending order, so PRs that carry
  Houston migrations may merge in any order; an id never changes once it has merged.
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

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
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
=======
## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- Setup runs in the background. While `.t3/setup-running` names a live PID, wait for it and do not run `vp i`. It ends with `.t3/setup-done` or `.t3/setup-failed` (with the error tail). With no marker at all, setup never ran here, so run `vp i` yourself.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing and the source is at most 500 MiB. Larger sources warn and dev starts with an empty database. `--no-seed` or `T3CODE_DEV_SEED=0` skips seeding. Manual migration still accepts larger sources and may use substantial disk space before pruning.
- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It rebuilds `<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.t3/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, auth sessions, and links to other environments, so your dev server never runs the developer's agents or reaches their other machines. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Before you push, run `vp run check:changed`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, tests beside changes, and the cross-file checks those miss. CI still runs the full test suites.
- While you iterate, run `vp test run <files>`. For big files, add `-t "<name>"`.
- Use `vp run typecheck`, not `npx tsc`; it caches per package. Both run tsc-rs (`typescript` is the `@tsc-rs/typescript` drop-in).
- Run `node -e` snippets from `apps/server` or the owning package. `effect` does not resolve from the repo root.
- Test behavior that can break, such as orchestration and event-sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in web and mobile copies of the same logic.
- [Testing](docs/internals/testing.md) carries these same test rules, plus review guidance, for review bots. Change both together.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in an existing case of the module's test file where one fits), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.
- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

- User-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers.

- Real agent turns cost money. To watch a turn stream through the pipeline and UI, use the free `Replay (dev)` provider that `vp run dev` registers; [test-t3-app](.agents/skills/test-t3-app/SKILL.md) shows how to start one. Use a real provider only when the change depends on that provider's behavior, and then pick its cheapest model, such as Haiku for Claude or Luna for Codex.

For mobile verification, a missing or outdated native client is an install step, not a blocker. Run `vp run mobile:install <ios|android> [device-id]` on the device host before starting Metro; it targets the only booted simulator or connected Android device when the id is omitted. It installs the dev client for this checkout's native fingerprint from the shared cache in seconds and builds only when no machine has built it yet, so prefer it over `expo run:*`, `xcodebuild`, or `gradlew`, which rebuild from scratch. Its stdout is one JSON line; build output goes to the log it names. See `test-t3-mobile` for the full workflow.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before you change that text, read [evals/README.md](evals/README.md) and run the evals it names. When you fix a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- If `origin` is git.cafe, follow [GitCafe mirror](docs/operations/development.md#gitcafe-mirror-optional): push to `origin`, open and track PRs with `cafe` and their git.cafe URLs, and keep `gh` for merging.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One request is one PR. Split it only when the maintainer asks. Outside contributions follow the stricter [one problem per PR](CONTRIBUTING.md#one-problem) rule.
- When babysitting: call `watch_pull_request` and end your turn. T3 Code wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

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
