# Architecture

> For maintainers. Using Houston? Start at the [README](../../README.md).

Houston runs one Tauri host and, per channel, one detached TypeScript server. The host
starts the server, or attaches to the one already running, and embeds the renderer, a built
Vite bundle. The renderer talks to the server over one authenticated loopback WebSocket and
to the host through a small desktop bridge. Agents run as provider sessions owned by the
server; quitting Houston closes the window and the connection, not the server or its runs.

Houston began as a port of T3 Code (MIT, see NOTICE) and is maintained as an independent
codebase.

```
┌──────────────────────────────┐   WebSocket RPC    ┌─────────────────────────────────────┐
│ houston (Tauri host)         │ (loopback, token)  │ server (apps/server, detached)       │
│  ┌────────────────────────┐  │◄──────────────────►│  threads · turns · runs              │
│  │ renderer (apps/web)     │  │                    │  provider adapters · orchestration-v2│
│  └────────────────────────┘  │                    │  MCP toolkits · SQLite · keychain    │
│  v2_server (start/attach),   │   spawns detached  └──────────────┬───────────────────────┘
│  desktop bridge, tray, sys/, │                                   │ SDK / app-server / ACP
│  v1_cleanup                  │                    ┌──────────────▼───────────────────────┐
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

### Start-up cleanup of v1 configuration

Once per start, on its own thread, the host stops the channel's v1 daemon units and removes
its v1 hook and MCP entries from the Claude, Codex, OpenCode, Antigravity and ZCode configs
(`src-tauri/src/v1_cleanup/`). Houston 1 runs its daemon and supervisor in one transient user
systemd unit named `houston-daemon-<channel>-<nonce>.service`; the host stops and disables that
exact unit, and signals the `daemon.json` pid only when no unit answered. It stands down while
a v1 daemon still runs, which would reinstall the entries, and it never writes the channel
directory. The `houston` MCP entries of Claude, Codex and Antigravity carry no channel marker,
so they leave only while no other channel's v1 daemon runs; Claude's leaves only through
`claude mcp remove`. WSL distros are not reached. The outcome reaches the renderer through the
desktop bridge for Settings ▸ Maintenance.

### Detach and shutdown

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
  host utilities (`spawn`, `pid`, `paths`, `keychain`, …) live in `src-tauri/src/sys/`.

## Repository map

| Path                   | Holds                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `apps/server`          | the server; Houston's additions under `src/houston/`                 |
| `apps/web`             | the renderer                                                         |
| `packages/contracts`   | the server ↔ renderer schema; Houston's under `src/houston/`         |
| `packages/*`           | the provider, source-control, client and shared packages             |
| `native/libghostty-vt` | the pinned terminal-emulation library the renderer's WASM build uses |
| `src-tauri`            | the desktop host                                                     |
| `scripts/`             | development, build, installation and safety checks                   |

## Data

One SQLite database per channel, under `<channel dir>/v2/`. Upstream's tables follow
upstream's migrations; Houston's tables live on the Houston migration track
(`houston_sql_migrations`), applied after upstream's and never entering its migrator. Secrets
live in the OS keychain, scoped by channel directory, project and provider. The one-time
import of Houston 1 workspaces, Tasks, task sources and Slack reads v1's `houston.db`
read-only.

## Platform notes

Linux and Windows are supported release platforms: WebKitGTK and an AppImage or `.deb` on
Linux, WebView2 and an NSIS installer on Windows. A platform-specific behaviour has an
equivalent elsewhere or a named limitation.
