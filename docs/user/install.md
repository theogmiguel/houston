# Installing Houston

Houston is a desktop app with a local server. The app starts, or attaches to, one detached
server for its channel; the server owns threads and agent runs, so closing the window does
not stop them.

## Requirements

| System          | Published artifacts    | Notes                                     |
| --------------- | ---------------------- | ----------------------------------------- |
| Linux, x86_64   | `.deb` and `.AppImage` | glibc 2.35 or newer                       |
| Linux, ARM64    | `.deb` and `.AppImage` | glibc 2.35 or newer                       |
| Windows, x86_64 | NSIS `.exe`            | Windows 10 or 11; not Authenticode-signed |
| Windows, ARM64  | none                   | no installer is published                 |
| macOS           | none                   | not built                                 |

The AppImage needs the FUSE 2 runtime (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04 and
newer). The `.deb` installs with your package manager. Other glibc distributions are best
effort; Alpine, NixOS and the BSDs have no official build.

You also need at least one provider configured. Houston runs the provider; it does not
provide an account for it.

## Installing

Download the current release from
[GitHub Releases](https://github.com/theogmiguel/houston/releases). On Linux, make the
AppImage executable and launch it, or install the `.deb`. On Windows, run the installer
from the Start menu. SmartScreen may warn because the Windows installer has no Authenticode
signature; the update itself is signed separately.

Houston keeps its data under the channel directory's `v2` child: `~/.houston/v2` for the
release channel on Linux, `%USERPROFILE%\.houston\v2` on Windows. A development build uses
its own channel and does not touch release state.

## Providers

Add and configure providers in **Settings ▸ Providers**. Houston can run threads with:

| Provider            | Notes                                             |
| ------------------- | ------------------------------------------------- |
| Claude              | Anthropic's Claude Code                           |
| Codex               | OpenAI Codex                                      |
| Cursor              | Cursor's agent                                    |
| Grok                | Grok                                              |
| fx                  | fx                                                |
| Kiro                | Kiro CLI; run `kiro-cli login` to sign in         |
| OpenCode            | OpenCode                                          |
| Antigravity         | Google Antigravity                                |
| Muse Code           | Muse Code                                         |
| Pi                  | Pi                                                |
| ACP registry agents | Agents Houston discovers through the ACP registry |

Each row shows whether the provider is installed, turned off, signed out, has rejected
credentials or is out of usage, with the action that resolves it. Sign-in belongs to the
provider; Houston never asks for your provider password.

## First run

With no project added, Houston shows **Add a project to start**:

- **Add folder** adds an existing folder as a project.
- **Clone a repository** clones a Git URL to a chosen machine and location.
- `Start without a project` opens a thread with no project.
- **Set up Houston** reopens the setup wizard.

The wizard has three steps: **Set up Houston**, **Connect your agents** (choose a provider to
start coding) and **Import your projects** (import projects and conversations from Claude
Code and Codex on the selected computers).

The server listens on this machine only unless network access is turned on in
**Settings ▸ Connections ▸ Sharing & access**. Each agent sends your prompts and the files it
reads to its own provider. See [Privacy and diagnostics](privacy.md).

## Platform differences

| Feature              | Linux                                         | Windows                                             |
| -------------------- | --------------------------------------------- | --------------------------------------------------- |
| Updates              | Signed download, then install                 | Signed download, then the NSIS installer            |
| Native notifications | Supported by the desktop notification service | Supported                                           |
| Keep in tray         | Available when a tray exists                  | Available when a tray exists                        |
| WSL backend          | Unavailable                                   | Experimental; x86_64 WSL 2 with glibc 2.35 or newer |
| Browser start page   | Lists loopback servers started in the project | No loopback server list                             |
| Browser automation   | Headless Chromium is downloaded on first use  | Headless Chromium is downloaded on first use        |

See [The right panel](right-panel.md) for browser and file features, and
[Updating Houston](updating.md) for installing over Houston 1.

## When Houston does not start

Run `npx houston-app triage` in a terminal. It needs Node.js 20.11 or newer and works on
Linux; on Windows, open the command palette in Houston and choose **What went wrong?**
instead. The command downloads the `houston-app` launcher from npm, which downloads the
server for the same version from the GitHub release, verifies its checksum and keeps it in
`~/.houston/v2/runtime/versions/`. It then starts Claude Code or Codex with a triage
playbook and this machine's Houston paths, versions and server status. The agent asks what
went wrong, reads Houston's logs and database without changing them, and proposes fixes
that run only after you approve them.

## Installing from source

See the [development runbook](../operations/development.md) for prerequisites, channels,
development commands and desktop builds.
