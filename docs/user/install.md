# Installing Houston

## Before you start

Houston is Linux-first, and Windows is also built and shipped:

| System | Published artifacts | Notes |
|---|---|---|
| Linux, x86_64 | `.deb` and `.AppImage` | needs glibc 2.35 or newer |
| Linux, ARM64 | `.deb` and `.AppImage` | needs glibc 2.35 or newer |
| Windows, x86_64 | NSIS installer | not code-signed; SmartScreen warns |
| Windows, ARM64 | none | no installer is published |
| macOS | none | not built |

glibc 2.35 is the Linux floor: Ubuntu 22.04 and Debian 12 both meet it, and so
do current Fedora and Arch. Other glibc distributions are best effort. musl
distributions (Alpine), NixOS and the BSDs have no official build — run from
source if you want to try. The AppImage mounts itself through the FUSE 2
runtime (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and newer); the `.deb`
installs with your package manager.

You also need at least one supported agent CLI already installed and logged in —
Houston hosts these CLIs, it does not provide accounts for them. See
[Providers](#providers) below for which CLIs Houston can spawn and drive.

## Installing the desktop app

Download a release from the project's GitHub releases page. Each tagged release ships:

- **Linux**: an `.AppImage` and a `.deb`.
- **Windows**: an NSIS installer (`.exe`).

There is no AUR package and no winget entry — install one of the artifacts above directly.

A release is a draft until the maintainer smoke-tests it; each release's notes list what
changed.

## Installing from source

See `docs/operations/development.md` for building and running Houston from the repository.

## Providers

Houston hosts ten agent CLIs. Seven are spawnable — you can open a pane running them
directly from Houston: **Claude Code**, **Codex**, **Antigravity**, **OpenCode**,
**Cursor**, **Grok** and **ZCode**. Three more are identity-only — Houston recognizes them from
their own startup banner if you run them yourself in a shell pane, but cannot spawn or
drive them: **Droid**, **Copilot**, **Aider**.

Houston never manages your login to any of these CLIs — sign in with each CLI the way
you normally would, before or after adding it as a pane.

For every provider it can spawn, Houston needs a small amount of integration in that
CLI's own configuration, so the CLI reports its lifecycle (idle, waiting, done) back to
Houston. That write is always a clearly marked block Houston owns, never a hand rewrite
of your file, and it is always reversible: turn the corresponding hook toggle off in
Houston and the block is removed, restoring the file to what it looked like before —
including deleting the file entirely if Houston is the one that created it.

### Claude Code

Houston writes a managed hooks block into your workspace's own
`.claude/settings.local.json` (not a global file — this happens once per workspace you
open Claude Code in). Each managed hook command in that file carries a trailing
`--houston-managed` marker; turning the hook toggle off for that workspace removes only
the entries carrying that marker, and deletes the `hooks` object or the file itself if
Houston was the one that created it.

Houston also registers itself as an MCP server in `~/.claude.json` (or under
`$CLAUDE_CONFIG_DIR` if you've set that), so agents in Claude Code panes can spawn and
talk to other panes. There is currently no automatic way to remove this MCP entry; remove
it yourself with `claude mcp remove houston` if you no longer want it.

### Codex

Houston writes managed hooks into `~/.codex/hooks.json`. Turning the hook toggle off
removes Houston's entries and, if Codex's `~/.codex/config.toml` had a legacy `notify`
line parked to make room for Houston's hooks, restores it.

Houston also registers an MCP server under `[mcp_servers.houston]` in
`$CODEX_HOME/config.toml` (or `~/.codex/config.toml`). As with Claude, there is no
automatic removal for this entry yet — take it out of `config.toml` by hand if needed.

### Antigravity

Houston writes managed hooks into `~/.gemini/config/hooks.json`, under a `houston` group
key. Turning the hook toggle off removes only that group's Houston-managed entries and
deletes the group or file if nothing else is left in it.

Houston also writes an MCP server entry directly into
`~/.gemini/config/mcp_config.json` (Antigravity has no CLI subcommand to add one, so
Houston edits the file). The entry carries a sibling `"_houston": "managed"` marker so it
can be told apart from anything else in that file, but there is no automatic removal yet
— remove the entry by hand if needed.

### OpenCode

Houston writes a whole plugin file, `houston-notify.js`, into OpenCode's plugin
directory (under your XDG config directory, `~/.config/opencode/plugins/`). Turning the
hook toggle off deletes that file outright — the file's own header names the
`--houston-managed` marker and states plainly that Houston rewrites it on install and
deletes it on uninstall.

Houston does not register an MCP server with OpenCode.

### Cursor

Houston writes managed hooks into `~/.cursor/hooks.json`. Turning the hook toggle off
removes only Houston's marked entries.

Houston also writes an MCP server entry directly into `~/.cursor/mcp.json` (Cursor's CLI
has no command to add one), under a different server name than any third-party servers
Houston syncs into the same file, and carrying the same `"_houston": "managed"` marker
Antigravity's entry uses. There is no automatic removal for this entry yet.

### Grok

Houston writes managed hooks into `~/.grok/hooks/houston.json`. Turning the hook toggle
off removes Houston's marked entries and deletes the file if nothing is left in it.

Houston also registers an MCP server under `[mcp_servers.houston]` in
`~/.grok/config.toml`. There is no automatic removal for this entry yet.

### ZCode

ZCode is Z.ai's coding agent for GLM models. Houston runs its terminal interface, the
`zcode` command. Z.ai publishes no installer for that command: build it from the official
source repository (`zai-org/ZCode`, `pnpm build:zcode`), or install the community package
with `npm install -g zcode-app-cli`. The runtime bundled with the ZCode desktop app has no
terminal interface (it stops with `Cannot find package '@zcode/tui'`) and cannot run in a
pane.

Sign in with ZCode itself: `zcode login zai` for the international Z.ai service, or
`zcode login bigmodel` for BigModel in mainland China. ZCode has no command-line model
option, so Houston refuses a model named for a ZCode pane, for example in `pane_spawn`;
choose the model inside ZCode with `/model`. ZCode takes no prompt on its command line
either: Houston pastes a pane's first prompt into ZCode's input once its interface has
drawn.

What is transmitted: ZCode sends prompts, code and tool results to the service you signed
in to — Z.ai, which processes data in Singapore, or BigModel, in China. For GLM Coding Plan
requests ZCode routes the call, credential included, through its own gateway at
`zcode.z.ai`. ZCode also attaches device and session identifiers to those calls, makes
automatic auxiliary calls of its own (titles, compaction, memory, goal checks), fetches
its catalog and configuration from `cdn-zcode.z.ai` in the background, and keeps local
logs of model input and output by default. None of this traffic passes through Houston,
and Houston sends nothing to Z.ai. The official command has no update check of its own;
Houston panes set `ZCODE_DISABLE_UPDATE_CHECK=1`, which turns off the one in the
`zcode-app-cli` package.

Turning the hook toggle on (Settings ▸ Agent setup ▸ ZCode) edits
`~/.zcode/cli/config.json`:

- one hook entry per lifecycle event, each carrying the `--houston-managed` marker;
- `hooks.enabled` set to `true`. ZCode runs no hook without it, and the switch covers every
  hook in the file: hooks of your own that were switched off run while Houston's are
  installed. Houston records the previous value and restores it once no Houston channel
  has entries left;
- the path of a plugin directory Houston owns (`~/.houston/zcode-plugin`) in
  `plugins.dirs`. The plugin gives ZCode Houston's pane tools. Its address and token come
  from variables Houston sets only in its own panes, so no token is written to disk and,
  outside a Houston pane, the plugin's server stays unregistered. There, `zcode plugins
  list` shows a `plugin_variable_missing` error for Houston's plugin; that is expected.
  In a pane, ZCode names the tools `mcp__plugin_houston_houston__pane_*` (the `dev`
  channel's are `mcp__plugin_houston-dev_houston__pane_*`) and asks for approval before
  each call unless the pane runs in yolo mode.

Turning the toggle off removes only Houston's entries and its plugin directory. ZCode
accepts strict JSON only; if the file does not parse, Houston refuses and names the
problem without changing it. Houston replaces the file whole, so ZCode never reads a
partly written one, and the keys come back in alphabetical order. If you later set
`hooks.enabled` to `false` yourself, Houston keeps it when it refreshes its entries at
startup. The toggle is refused on Windows, because Houston's hook command needs a POSIX
shell; ZCode panes still run there, without status or pane tools.

### Droid, Copilot, Aider

Houston does not install hooks or an MCP server for these three. It only recognizes them
by their own startup banner if you run one yourself in a shell pane; it cannot spawn them
or read their status.

## First run

With no workspaces added yet, Houston shows a single "No workspaces yet" screen with one
button: add a project folder as a workspace. Immediately after adding your first
workspace, Houston walks through two more one-at-a-time screens — turning on
agent-to-agent orchestration, and installing hooks for a provider — each skippable. None
of the three screens reappears once its condition is already met, and there is no stored
"onboarding complete" flag: removing your last workspace later puts you back on the same
"No workspaces yet" screen.
