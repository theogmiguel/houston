# Installing Houston

## Before you start

Houston ships official desktop packages for Linux and Windows:

| System | Published artifacts | Notes |
|---|---|---|
| Linux, x86_64 | `.deb` and `.AppImage` | needs glibc 2.35 or newer |
| Linux, ARM64 | `.deb` and `.AppImage` | needs glibc 2.35 or newer |
| Windows, x86_64 | NSIS `.exe` installer | Windows 10 or 11; not Authenticode-signed |
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
[Providers](#providers) below for which CLIs Houston can spawn and drive, and
[Installing the CLIs](#installing-the-clis) for each vendor's install command.

## Installing the desktop app

Download the current release from
[GitHub Releases](https://github.com/theogmiguel/houston/releases). Current releases ship:

- **Linux**: an `.AppImage` and a `.deb`.
- **Windows**: an NSIS installer (`.exe`).

On Linux, choose the package matching your architecture. For an AppImage, make the file
executable and launch it. Install a `.deb` with your package manager. On Windows, run the
`Houston_<version>_x64-setup.exe` installer and launch Houston from the Start menu.
SmartScreen may warn because the installer has no Authenticode signature; its updater
signature verifies Houston updates and does not replace Windows code signing.

Windows installers have been published since v0.14.0; older releases contain Linux
packages only.

There is no AUR package and no winget entry — install one of the artifacts above directly.

The Windows installer also carries the Linux daemon that Houston copies into a WSL distro
when you enable one; see [WSL](wsl.md).

A release is a draft until the maintainer smoke-tests it; each release's notes list what
changed.

## Installing from source

See the [development runbook](../operations/development.md) for building and running Houston
from the repository on Linux or Windows.

## Platform differences

Both platforms support persistent terminal panes, agent orchestration, tasks, routines,
Git and pull request tools, files, the editor and manual browser navigation. Some features
have narrower support:

| Feature | Linux | Windows |
|---|---|---|
| [Updates with live sessions](updating.md) | Keep sessions running when daemon handoff is available | Stop sessions before installing |
| [Native desktop notifications](notifications.md) | Supported by the desktop notification service | Unavailable; in-app notices and taskbar counts remain available |
| [Dictation](voice.md) | Local Whisper or Groq | Groq; the local engine is unavailable |
| [Browser element picking and agent DOM actions](files-editor-browser.md) | Supported with consent | Unavailable; navigation, history and normal reload work |
| [WSL environments](wsl.md) | Unavailable | Experimental; x86_64 WSL 2 distros with glibc 2.35 or newer |

Provider-specific hook and restore limits are described below and in
[Agent status](agent-status.md) and [Panes and grids](panes-and-grids.md).

## Providers

Houston hosts ten agent CLIs. Five are spawnable — you can open a pane running them
directly from Houston: **Claude Code**, **Codex**, **Antigravity**, **OpenCode** and
**ZCode**. Five more are identity-only — Houston recognizes them from their own startup
banner if you run them yourself in a shell pane, but cannot spawn or drive them:
**Cursor**, **Grok**, **Droid**, **Copilot**, **Aider**.

Houston never manages your login to any of these CLIs — sign in with each CLI the way
you normally would, before or after adding it as a pane.

For every provider it can spawn, Houston needs a small amount of integration in that
CLI's own configuration, so the CLI reports its lifecycle (idle, waiting, done) back to
Houston. That write is always a clearly marked block Houston owns, never a hand rewrite
of your file, and it is always reversible: turn the corresponding hook toggle off in
Houston and its entries are removed, preserving unrelated configuration. Some installers
also delete an empty file or object that Houston created.

### Installing the CLIs

Houston does not install agent CLIs for you. Install at least one from its vendor; the
commands below come from each vendor's own install guide, and Houston can spawn a CLI
once its command is on your PATH.

- **Claude Code** ([install guide](https://code.claude.com/docs/en/setup)):
  `curl -fsSL https://claude.ai/install.sh | bash` on macOS, Linux and WSL, or
  `irm https://claude.ai/install.ps1 | iex` in Windows PowerShell; alternatively
  `npm install -g @anthropic-ai/claude-code` with Node.js 22 or newer.
- **Codex** ([install guide](https://learn.chatgpt.com/docs/codex/cli)):
  `curl -fsSL https://chatgpt.com/codex/install.sh | sh` on macOS and Linux, or
  `npm install -g @openai/codex`.
- **Antigravity** ([install guide](https://antigravity.google/docs/getting-started?tab=cli)):
  `curl -fsSL https://antigravity.google/cli/install.sh | bash` on macOS and Linux, or
  `irm https://antigravity.google/cli/install.ps1 | iex` in Windows PowerShell.
- **OpenCode** ([install guide](https://opencode.ai/docs)):
  `curl -fsSL https://opencode.ai/install | bash` on macOS and Linux, or
  `npm install -g opencode-ai`.
- **ZCode**: Z.ai publishes no installer for the `zcode` command. Build it from the
  official [ZCode repository](https://github.com/zai-org/ZCode) or install the community
  package with `npm install -g zcode-app-cli`; see [ZCode](#zcode) below.

### Claude Code

Houston writes managed lifecycle hook entries into `~/.claude/settings.json`, or
`settings.json` in `CLAUDE_CONFIG_DIR` and Houston account profile directories. Each
command carries a channel-specific `--houston-managed` marker and exits silently when
`TR_SESSION` is empty. Claude launched from any directory inside a Houston pane can
report status. Turn the switch off in Settings ▸ Agents ▸ CLIs ▸ Claude to remove
Houston's entries while preserving your hooks and other settings. Migration removes
Houston's old entries from workspace `.claude/settings.local.json` files. On Windows,
install Git for Windows to provide Git Bash for Claude lifecycle hooks, then enable the
Claude hook in Settings ▸ Agents ▸ Claude. If Git Bash is unavailable, Claude reports a
hook error instead of reporting status.

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

### Cursor and Grok

Houston no longer starts, configures or reports status for Cursor or Grok. On startup it
removes what earlier versions wrote, and only that:

- Houston's marked entries in `~/.cursor/hooks.json` and `~/.grok/hooks/houston.json`
  (the latter is deleted once nothing else is left in it).
- The `houston` entry marked `"_houston": "managed"` in `~/.cursor/mcp.json`, and any
  servers the MCP manager synced into that file.
- `[mcp_servers.houston]` in `~/.grok/config.toml`, only when its `url` and `Authorization`
  header are the placeholders Houston wrote; an edited entry stays, and the log names it.
- Houston's managed worktree-trust blocks in `~/.grok/trusted_folders.toml`.

Existing Cursor and Grok panes are kept as history. They cannot be restarted from Houston:
close them, or run the CLI yourself in a shell pane, where Houston still recognizes it.

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
either: Houston pastes a pane's first prompt into ZCode's input once that input is ready
to take it, which on a cold start can be several seconds after the pane opens (after a
minute it pastes regardless), and counts it delivered only when ZCode's prompt hook
reports it. Without that
report Houston presses Enter once more, never pastes the prompt a second time, and then
tells the pane's parent (or shows an error) to check the pane; the message never repeats
the prompt. Without the hook toggle on, nothing can confirm the paste, and ZCode also
reports no session ID, so its panes have no conversation to reopen after a shutdown or
crash (see [panes](panes-and-grids.md#idle-and-restore-behavior)).
ZCode has no read-only mode on its command line (it turns planning on only inside its own
interface, with `/plan`), so Houston does not use it to plan a task; see
[Tasks](tasks.md#planning-a-task).
ZCode loads a skill with `/skill <name>`, so a skill used in a ZCode pane is sent that way,
and Skills shows and copies it that way while a ZCode pane is focused. ZCode finds skills
in `~/.zcode/skills`, `~/.agents/skills` and the same folders in the project, not in
`~/.claude/skills`; Houston's skill push copies your Claude skills into `~/.zcode/skills`,
as it does for Codex, and agent spawning installs its `houston-pane` skill there.

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

Turning the hook toggle on (Settings ▸ Agents ▸ CLIs ▸ ZCode) edits ZCode's settings file.
The `zcode-app-cli` package reads `~/.zcode/cli/setting.json`; the upstream command reads
`~/.zcode/cli/config.json`. Houston edits each of the two that exists, and creates
`config.json` when neither does (the package copies it into `setting.json` on its first
start). The edit adds:

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

Turning the toggle off removes only Houston's entries and its plugin directory; a command
of yours in the same hook group stays. ZCode accepts strict JSON only; if the file does not
parse, Houston refuses and names the problem without changing it. Houston replaces the file
whole, so ZCode never reads a partly written one, and the keys come back in alphabetical
order. Edits from Houston's installed and development channels take turns through a lock
file, `config.json.houston-lock`, beside the settings file. If the file changes while
Houston edits it, Houston reads it again rather than overwriting the change, and refuses
with nothing written if it keeps changing. If you later set `hooks.enabled` to `false`
yourself, Houston keeps it when it refreshes its entries at startup. On Windows, where
ZCode runs a shell command hook through `cmd.exe`, each entry instead names Houston's hook
helper, `claude-hook.exe` in the channel's state directory (for example
`%USERPROFILE%\.houston\bin`), which ZCode starts directly. Outside a Houston pane the
helper exits at once without doing anything. Turn the toggle off before you uninstall
Houston or delete its state directory: once the helper is gone, every ZCode session, in a
Houston pane or not, reports `Hook process failed` until Houston's entries are removed from
the settings file.

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
