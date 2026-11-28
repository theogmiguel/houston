# Houston contributor instructions

Houston is mission control for coding agents. It ships today as a desktop app on Linux and
Windows; that is the current state, not a limit. An Electron host starts, or attaches to, a
TypeScript server for its channel; the renderer presents each agent conversation as a
**thread**. Closing the window keeps the host in the tray, so the server and
its agent runs continue; quitting stops the server the host started.

## How to read this file

These are good defaults, not hard rules. The maintainer's direction in a task overrides
anything here except the items under "Never do these". Prefer ambitious ideas built as simple
systems: do not keep complexity because it exists, and do not add machinery because it looks
impressive. Find the real constraint and build the smallest model that makes correct behaviour
unsurprising. When a default conflicts with the task, follow the task and say in one line which
default was set aside. Verify documentation against the implementation and correct
discrepancies in the same change.

## What Houston does not compromise on

- **The server owns the work.** Threads and runs live in the server; a window is only a client,
  and closing it never stops a run.
- **The user's data stays the user's.** State is local by default. Secrets live in the secret
  store, one 0600 file per secret in a 0700 directory, never in the database, logs, traces,
  errors, RPC replies or stream events. Telemetry never carries source code, prompts, agent
  responses, file contents, credentials or paths, and it can be turned off.
- **Honest about the network.** A feature that sends data off the machine can be turned off and
  sends nothing while off. Its user-facing text is true about what it sends and to whom. Houston
  may offer its own services, such as a relay or notifications, under that rule. A credential
  never goes to a destination the user did not choose. `docs/user/privacy.md` lists what is
  sent before it ships.
- **Performance.** The renderer runs in an Electron webview: watch WebSocket payloads, long
  lists and animation cost. Motion rules live in [renderer](docs/internals/renderer.md).

## Never do these

These are the only hard rules. [Invariants](docs/internals/invariants.md) carries the reasons.

1. **Identify processes by channel.** Stop a server only by the PID its channel's
   `server-runtime.json` names. Never use `pkill -f`, `pgrep | kill`, or a PID chosen by
   matching a name, path or parent PID. Host code signals processes only through
   `crate::sys::pid`.
2. **Protect installed state.** Never point a development server at `~/.houston` or
   `~/.houston/v2`, or open v1's database read-write. `--channel release` requires explicit
   instruction. Tests use temporary directories, never the real home.
3. **One server per channel.** Keep upstream's server ownership lock; a second server for the
   same base directory exits instead of sharing its database.
4. **Never touch the host keyring.** Server tests use the in-memory secret store; only
   `server.ts` provides the live one. Do not run `gnome-keyring-daemon`, least of all with
   `--unlock`: it re-encrypts the user's login keyring. Host Secret Service tests run through
   `scripts/with-test-keyring.sh`. The OS keychain is read once, by the import of earlier
   builds' tokens, and never written or deleted.
5. **Never touch the user's repositories by accident.** Git commands that act for the user
   neutralise configuration that could reach refs outside their worktree (`rebase.updateRefs`,
   `push.followTags`, hooks, signing, submodule recursion). Push only with a lease to branches
   the server owns, and leave the user's checkout byte-identical.
6. **Never write v1 state.** v2 never deletes, moves or opens v1's state under `~/.houston`
   read-write. The one-time import reads v1's `houston.db` read-only, and the host's one v1
   cleanup edits only the agent CLI configs v1 changed.
7. **Keep external configuration reversible.** Changes to an agent CLI's configuration are
   reversible managed-marker blocks. `~/.claude.json` changes only through `claude mcp`.

## Working defaults

- Agent status comes from each provider adapter's structured stream, never from terminal output.
- Every server ↔ renderer message is typed in `packages/contracts`. A new WebSocket method is
  listed in `RpcInstrumentation.ts` and given a scope in `RpcAuthorization.ts`.
- Houston code usually lives under `houston/` directories, with `houston.*` RPC names and
  Houston tables on the Houston migration track. This keeps upstream syncs cheap; code shared
  with upstream stays where upstream has it.
- Ported code carries the MIT notice in `NOTICE` and `third-party-licenses.config.json`.
- Text from outside (GitHub, Notion, Slack, imported files) is bounded and attributed before it
  reaches a prompt; text Houston sends out is escaped.
- Keep provider complexity at provider boundaries, server models testable and renderer logic
  focused on presentation.
- Errors include the offending value and expected shape. A limit's error names the limit, the
  actual value and the requested operation.
- Tunable constants carry a one-line rationale; measure when their value affects performance.
- A credential carries only the capabilities its thread needs: a read-only thread runs with the
  provider's own read-only sandbox, no user MCP servers and no MCP credential beyond the
  operations it must submit.
- Comments explain non-obvious usage and follow the comment hygiene budget. Avoid unrelated
  product names in code and comments; document the technical constraint instead.
- Change only what the task requires.

## Hit every surface

The most common defect is a change that works on the tested path and is missing elsewhere.
Before calling work done, say which of these applied.

- **Providers.** Each provider gets a decision. A refusal names the provider and the missing
  capability.
- **Reverse states.** Every way in has a way out and a way to see it. Settings show their
  current value.
- **Platforms.** Linux and Windows ship today. A platform-specific behaviour has an equivalent
  or a named limitation. Do not rule out other platforms or clients without a reason.
- **Contracts.** Wire changes go in `packages/contracts`, so the server and every client
  follow.
- **Migrations.** A Houston migration takes the next free id. An id never changes once merged.
- **Network.** Apply the rule under "What Houston does not compromise on".
- **Documentation.** The PR title describes user-visible behaviour. Update the `docs/user/`
  page when usage changes.

## Terms

Use the [glossary](docs/internals/glossary.md) consistently:

- **Contributor agent:** the agent editing Houston, usually running inside the installed
  release. Check `HOUSTON_SESSION` before operations that could affect the pane hosting it.
- **Server:** the TypeScript server under `apps/server`, run by the host for one **channel**.
  The `release` channel keeps its state in `~/.houston/v2`; `dev` uses `~/.houston-dev/v2`.
- **Thread:** a structured conversation with one agent. A **turn** is one request and its
  answer; a **run** is the provider session that serves a thread.
- **Side thread:** a read-only thread beside another one. It never writes to its source.
- **Orchestration:** agent-to-agent work through orchestration-v2 (`delegate_task`, subagents)
  and the server's MCP toolkits.
- **Houston migration track:** Houston's own migration table and ids, applied after upstream's.

## Verifying

- Run focused tests with `pnpm --filter @houston-app/cli exec vp test run <files>`. A filter
  that matches no package, or a `-t` pattern that matches no test, exits 0; confirm with
  `--reporter=verbose` that a proof ran.
- Before a push, run `pnpm check:changed`. CI runs the full suites, and `ci-gate` is the single
  aggregate check. Run a full suite locally when the change is broad.
- A bug fix has a regression test that fails before the fix. Parsers, security boundaries,
  persistence and migrations, concurrency and cross-platform paths get tests; copy and wiring
  do not.
- Code that reaches a provider, GitHub, Notion, Slack or the secret store runs against replay
  fixtures, local fakes and the in-memory secret store, never the real service.
- Native changes: run `cargo fmt`, `cargo clippy --all-targets -- -D warnings` and `cargo test`
  in `apps/desktop/native` and `native`. On Linux, wrap heavy builds in
  `scripts/oom-shield.sh` with `nice -n 19` and `-j 3`; on Windows, limit Cargo to three jobs.
  Never run concurrent Cargo workloads.
- Commands: [development runbook](docs/operations/development.md). Failure modes:
  [testing](docs/internals/testing.md). Pipeline: [CI](docs/internals/ci.md).

## Pull requests and releases

- Changes to `main` go through a PR, including documentation. Merge only with green CI and
  completed local gates.
- Use conventional PR titles that describe user-visible behaviour, for example
  `fix(threads): a renamed thread keeps its name after a restart`.
- Each PR body has a `## Release notes` section; use `None` for internal-only changes.
- Explain the problem and the resulting change in the PR body. Omit generated-by footers and
  agent session links. Keep one concern per commit.
- Destructive Git operations require explicit authorization.
- Regenerate lockfiles and the licence inventory instead of hand-merging them.
- Only a release changes versions. Feature PRs leave the manifests of `apps/desktop`,
  `apps/server` and `apps/web` alone; the **Cut release** workflow updates them with
  `scripts/set-version.sh`.
- Release runbook: [release](docs/operations/release.md).

## Documentation

Most code changes need no internal documentation change. If reading the code answers the
question, leave it out.

- `docs/user/`: task guidance for application users, with the relevant settings paths.
- `docs/internals/`: architectural constraints, rationale and non-obvious risks.
- `docs/operations/`: maintainer runbooks for development, releases and the Linux testbed.

Rewrite obsolete text instead of appending to it. Do not commit plans, research, audits or
scratch files; a merged PR is the implementation record. Add new vocabulary to the glossary.
`scripts/check-doc-hygiene.sh` enforces the doc tree shape and rejects diary content, dates,
phase numbering and session narrative. Track work in GitHub issues and proposals in
Discussions, following [CONTRIBUTING.md](CONTRIBUTING.md).

## Where code lives

The server owns threads and agent runs independently of connected clients. See the
[architecture overview](docs/internals/overview.md) and the
[style guide](docs/internals/styleguide.md).

- `apps/server`: the server; Houston's additions under `src/houston/`.
- `apps/web`: the renderer.
- `packages/contracts`: the server ↔ renderer schema; Houston's under `src/houston/`.
- `packages/*`: the provider, source-control and shared packages.
- `apps/desktop`: the Electron host, server supervision, desktop bridge and tray.
- `apps/desktop/native` and `native`: the host's native helper crates.
- `scripts/`: development, build, installation and safety checks.
