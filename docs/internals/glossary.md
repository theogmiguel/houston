# Glossary

Words that collide, and the meaning Houston gives them. Where a term has a home in code, it is
named.

## People and roles

| Term | Meaning |
|---|---|
| **you** | The coding agent changing Houston. It may itself run inside a pane of the installed release (`HOUSTON_SESSION` is set). |
| **maintainer** | Develops and releases Houston. A maintainer's installed app uses the same protected release channel as any user's install. |
| **user** | The person running Houston to direct agents. One per install. |
| **dogfooding** | Running Houston's own development inside Houston. `sys/env_hygiene.rs` scrubs inherited agent markers so a dogfooded host does not leak its identity into what it spawns. |

## Server and state

| Term | Meaning | Code |
|---|---|---|
| **server** | The TypeScript server under `apps/server`: upstream's, with Houston's additions under `src/houston/`. The host runs one, detached, per channel. | `apps/server`, `src-tauri/src/v2_server.rs` |
| **host** | The Tauri desktop application. It starts or attaches to its channel's server, bridges the desktop to the renderer, and runs the v1 cleanup at start. | `src-tauri` |
| **channel** | An isolated state universe: `release` (`~/.houston`), `dev` (`~/.houston-dev`) or a named one (`~/.houston-<name>`). | `sys/paths.rs` |
| **channel directory** | A channel's directory under the home. v2 writes only its `v2/` child; anything else in it is v1 state. | `sys/paths.rs::dir_for`, `v2_server::base_dir` |
| **runtime file** | `<channel dir>/v2/userdata/server-runtime.json`: how the host and other clients find the channel's running server, and the PID a stop uses. | `v2_server.rs` |
| **thread** | A structured conversation with one agent. A **turn** is one request and its answer; a **run** is the provider session that serves a thread. | `packages/contracts` |
| **side thread** | A read-only thread beside another one (an aside, a second opinion, a task planner or reviewer). It never writes to its source. | `apps/server/src/houston/sideThreads.ts` |
| **provider adapter** | The server's driver for one agent runtime; its structured stream is the only source of agent status. | `apps/server/src/orchestration-v2/Adapters` |
| **orchestration** | Agent-to-agent work through orchestration-v2 (`delegate_task`, subagents) and the server's MCP toolkits. | `apps/server/src/orchestration-v2`, `apps/server/src/mcp` |
| **Houston migration track** | Houston's own migration table (`houston_sql_migrations`) and ids, applied after upstream's. Ids are taken in merge order. | `apps/server/src/houston/migrations.ts` |
| **v1 state** | What a v1 install left directly under a channel directory (`houston.db`, scrollback, `bin/claude-hook` and the daemon's discovery files). Read-only to v2; only the Tasks and task-source imports read `houston.db`. | `apps/server/src/houston/*/V1Import.ts` |
| **v1 cleanup** | The host's start-up removal of its own channel's v1 hook and MCP entries from the agent CLI configs. It stands down while that channel's v1 daemon runs. | `src-tauri/src/v1_cleanup/` |
| **managed marker** | The `--houston-managed[=<channel>]` token on every entry Houston wrote into an agent CLI's config, matched per token, never as a substring. | `v1_cleanup/files.rs` |

<!-- Host and renderer terms (Theo): workspace, grid, drawer and renderer terms. -->

## Engineering nouns

| Term | Meaning |
|---|---|
| **copy, then adapt** | Upstream files are copied as they are and changed only where Houston differs; each changed file is listed in `upstream.json` `adapted`. |
| **upstream drift** | Differences between a copied file and the pinned upstream commit; `scripts/check-upstream.mjs` reports them. |
| **safety scripts** | The hermetic `scripts/check-*.sh` steps the `safety-checks` CI job runs on every push. |
| **oom-shield** | `scripts/oom-shield.sh`: a memory-capped, niced, serialized scope for heavy builds. |
| **gate** | The verification set for a cadence: focused checks while iterating, full checks at integration boundaries and before a push. |
| **discriminator** | The specific re-run that distinguishes a known flaky shape from a real failure. |
