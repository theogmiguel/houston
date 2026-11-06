# Architecture

> For maintainers. Using Houston? Start at the [README](../../README.md).

Houston runs one Electron host and, per channel, one detached TypeScript server. The host
starts the server, or attaches to the one already running, and embeds the renderer, a built
Vite bundle. The renderer talks to the server over one authenticated loopback WebSocket and
to the host through a small desktop bridge. Agents run as provider sessions owned by the
server; quitting Houston closes the window and the connection, not the server or its runs.

Houston began as a port of T3 Code (MIT, see NOTICE) and is maintained as an independent
codebase.

```
┌──────────────────────────────┐   WebSocket RPC    ┌─────────────────────────────────────┐
│ houston (Electron host)      │ (loopback, token)  │ server (apps/server, detached)       │
│  ┌────────────────────────┐  │◄──────────────────►│  threads · turns · runs              │
│  │ renderer (apps/web)     │  │                    │  provider adapters · orchestration-v2│
│  └────────────────────────┘  │                    │  MCP toolkits · SQLite · secrets     │
│  backend (start/attach),     │   spawns detached  └──────────────┬───────────────────────┘
│  desktop bridge, tray,       │                                   │ SDK / app-server / ACP
│  v1 cleanup, native crates   │                    ┌──────────────▼───────────────────────┐
└──────────────────────────────┘                    │ agent runtimes: Claude, Codex, ...    │
                                                     └──────────────────────────────────────┘
```

## Contents

| Doc                            | Covers                                          |
| ------------------------------ | ----------------------------------------------- |
| this file                      | process model, boundaries, repository map, data |
| [invariants.md](invariants.md) | the rules, what enforces them, and why          |
| [renderer.md](renderer.md)     | the renderer                                    |
| [testing.md](testing.md)       | where tests live, how to read a failure         |
| [glossary.md](glossary.md)     | the words that collide                          |

## Process model

### One server per channel, and a host that is a client

The host resolves its channel from `--channel` (debug builds default to `dev`), then reads
`<channel dir>/v2/userdata/server-runtime.json`. When the server it names answers, the host
attaches; otherwise it spawns one detached (`setsid` on Linux, a job breakaway on Windows)
and waits for the runtime file. Upstream's server ownership lock makes a second server for
the same directory exit instead of sharing the database. The host hands the renderer the
server's origin and a bootstrap credential; the renderer then speaks upstream's typed
WebSocket RPC, whose messages are defined in `packages/contracts`.

### Channels

A channel is an isolated state universe: `release` uses `~/.houston`, `dev` uses
`~/.houston-dev`, and a named channel `~/.houston-<name>`. The server keeps everything under
`<channel dir>/v2/`. A v1 install's state directly under the channel directory is read-only
to v2.

Orchestration state is decided as events, and projections are the source of truth once they apply
them. The [v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

Once per start, on its own thread, the host stops the channel's v1 daemon units and removes
its v1 hook and MCP entries from the Claude, Codex, OpenCode, Antigravity and ZCode configs
(`apps/desktop/native/houston-v1-cleanup`). Houston 1 runs its daemon and supervisor in one transient user
systemd unit named `houston-daemon-<channel>-<nonce>.service`; the host stops and disables that
exact unit, and signals the `daemon.json` pid only when no unit answered. It stands down while
a v1 daemon still runs, which would reinstall the entries, and it never writes the channel
directory. The `houston` MCP entries of Claude, Codex and Antigravity carry no channel marker,
so they leave only while no other channel's v1 daemon runs; Claude's leaves only through
`claude mcp remove`. WSL distros are not reached. The outcome reaches the renderer through the
desktop bridge for Settings ▸ Maintenance.

The event log only keeps what live readers need: about a day of history for reconnect replay and
command-id retries.
[ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) deletes
older events the projections cover, so projections cannot be rebuilt from the log. It keeps each
stream's newest event (high-water marks, stream versions, snapshot sequences), `thread.created`
(the legacy importer's marker), every `running` run update (Codex usage history reads the first
of each attempt), and prompt anchors that retained subagent rows reference. A client whose cursor
is below both its thread's newest event and the recorded pruned-through sequence missed pruned
events, so it resumes from a snapshot; an idle thread's cursor resumes without one. Resumes
recheck that sequence after reading the replay, since a pass can prune during the read. V2 command
receipts stay for idempotency: a retry older than the retained history is still deduplicated,
but its replay comes back without the pruned events. Receipts of imported legacy commands are
removed once their threads are imported.

Retained events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

Closing the window, or quitting from the tray, ends the host process. The server and its agent
runs continue; the next launch attaches to the server the runtime file names. Stopping a
server uses the PID that file names.

<!-- Host details (Theo): tray and hide-to-tray, desktop bridge, updates, WSL. -->

## Boundaries that matter

- **Status comes from adapters.** Agent status is what a provider adapter's structured stream
  reports; nothing reads terminal output for it.
- **Houston code lives under `houston/`.** Houston-owned code sits in `houston/` directories
  beside the ported files it extends.
- **Contracts are the only wire.** A server ↔ renderer message that is not in
  `packages/contracts` does not exist; a new WebSocket method is also listed in
  `RpcInstrumentation.ts` and given a scope in `RpcAuthorization.ts`.
- **The host owns no agent state.** It supervises the server and bridges desktop features;
  host utilities and native helpers live under `apps/desktop/src` and `apps/desktop/native`.

## Repository map

| Path                   | Holds                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `apps/server`          | the server; Houston's additions under `src/houston/`                 |
| `apps/web`             | the renderer                                                         |
| `packages/contracts`   | the server ↔ renderer schema; Houston's under `src/houston/`         |
| `packages/*`           | the provider, source-control, client and shared packages             |
| `native/libghostty-vt` | the pinned terminal-emulation library the renderer's WASM build uses |
| `apps/desktop`         | the Electron host, desktop bridge, tray and native helper crates     |
| `native`               | the Linux snapshot helper crates                                     |
| `scripts/`             | development, build, installation and safety checks                   |

## Data

One SQLite database per channel, under `<channel dir>/v2/`. Upstream's tables follow
upstream's migrations; Houston's tables live on the Houston migration track
(`houston_sql_migrations`), applied after upstream's and never entering its migrator. Secrets
live in the server's secret store, one 0600 file per secret in a 0700 `secrets` directory
beside the database, so a channel's tokens are scoped by its directory and by project and
provider. A server needs no OS keychain, which is often absent or locked on a headless host.
At startup, tokens an earlier build kept in the OS keychain are copied into the store once;
the keychain is read, never written or deleted, and an unavailable keychain is a warning that
retries at the next start. The one-time import of Houston 1 workspaces, Tasks, task sources
and Slack reads v1's `houston.db` read-only.

## Platform notes

Linux and Windows are supported release platforms: Chromium packaged as an AppImage or
`.deb` on Linux, and Chromium packaged by an NSIS installer on Windows. A platform-specific behaviour has an
equivalent elsewhere or a named limitation.
