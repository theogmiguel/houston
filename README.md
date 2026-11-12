# Houston

**Local-first mission control for CLI coding agents on Linux and Windows.**

Houston runs coding agents in persistent threads served by a detached local server. Agent
runs continue when the window closes, and agents can delegate work to other threads through
the server's orchestration tools.

[Download Houston](https://github.com/theogmiguel/houston/releases) ·
[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

## Why Houston

- **Persistent threads.** Closing the desktop app detaches from the server without stopping
  running agents. Threads and their history survive restarts.
- **Workspaces.** Arrange threads and their surfaces in columns, panes and tabs; shortcuts, find
  and actions follow the focused pane.
- **Agent orchestration.** An agent can start, message and wait for other threads through
  the server's orchestration tools, and delegate work in managed Git worktrees.
- **Tasks.** Keep a backlog per project, start tasks in isolated worktrees and review the
  result before marking work complete. GitHub issues, Notion and Slack requests can feed it.
- **Workspace tools.** Git changes, files, an editor, a browser and pull requests open in the
  right panel next to the thread. Pull requests include a local merge queue.
- **Session insights.** Thread status, notifications and usage estimates help track work.
- **Local control plane.** Houston has no account or hosted control plane. Session state remains
  local, and secrets managed by Houston are kept in files only your user can read.

## Supported agents

Houston runs threads with Claude, Codex, Cursor, Grok, fx, OpenCode, Antigravity, Muse Code,
Pi and agents discovered through the ACP registry, when their executable is installed.
Provider installation and authentication remain the provider's responsibility; see the
[installation guide](docs/user/install.md#providers).

## Install

Download the current release from [GitHub Releases](https://github.com/theogmiguel/houston/releases).

| Platform       | Official artifacts | Support baseline    |
| -------------- | ------------------ | ------------------- |
| Linux x86_64   | AppImage, `.deb`   | glibc 2.35 or newer |
| Linux ARM64    | AppImage, `.deb`   | glibc 2.35 or newer |
| Windows x86_64 | NSIS `.exe`        | Windows 10 or 11    |

Linux and Windows receive official release packages. Windows support starts with v0.14.0.
macOS and Windows ARM64 do not have official builds. Alpine, NixOS, BSD and other
non-glibc environments do not receive official packages; community or source builds are
best effort.

The Windows installer is not Authenticode-signed, so SmartScreen may warn on first launch.
Release artifacts are signed for Houston's updater and verified before installation.
Some features have platform-specific limits; see the
[installation guide](docs/user/install.md#platform-differences) for the supported paths.

For source builds, prerequisites and platform-specific commands, follow
[`docs/operations/development.md`](docs/operations/development.md).

## How it works

The desktop app starts, or attaches to, a detached TypeScript server for its channel and
talks to it over one authenticated WebSocket. The server owns threads, provider adapters,
local state and the orchestration tools; agent status comes from each provider's structured
stream. Closing the window removes the client; it does not stop the server or its agent runs.

The architecture is documented in [`docs/internals/overview.md`](docs/internals/overview.md).

## Privacy and updates

Local-first does not mean offline. Agent CLIs, Git and GitHub operations, browser and MCP
integrations and model downloads use their respective network services when invoked. Houston has no hosted account; [Privacy and diagnostics](docs/user/privacy.md) describes usage and crash data. Its background
update check queries GitHub, can be disabled, and never installs without an explicit click.

## Documentation

The [documentation index](docs/README.md) explains how to read the docs for an installed
release or the current source.

- [Install Houston and configure providers](docs/user/install.md)
- [Work with threads and workspaces](docs/user/threads-and-workspaces.md)
- [Manage tasks and agent work](docs/user/tasks.md)
- [Inspect Git changes and pull requests](docs/user/changes.md)
- [Configure notifications](docs/user/notifications.md)
- [Inspect token usage and estimated costs](docs/user/usage.md)
- [Connect machines and task sources](docs/user/connections.md)
- [Update an installed release](docs/user/updating.md)
- [Browse the complete documentation index](docs/README.md)

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening an issue or
pull request. Feature proposals belong in the
[Ideas discussion](https://github.com/theogmiguel/houston/discussions/categories/ideas).

## License

Houston is licensed under Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
The licence does not grant rights to the Houston name or marks.
