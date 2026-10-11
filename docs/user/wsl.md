# WSL

## What an environment is

On Windows, Houston can open folders that live inside a WSL distro as workspaces beside
your Windows workspaces, in the same rail and grid. Each place Houston runs agents is an
**environment**: the Windows machine itself, or one WSL distro you have enabled.

Houston runs its own Linux daemon inside each enabled distro. Panes in a WSL workspace
are real terminals inside that distro: shells, agent CLIs, hooks, status, orchestration,
the git surface and restore work there as they do in Linux Houston. This feature is
labelled **Experimental**.

## Requirements

- Windows on x64, with WSL 2. Distros running under WSL 1 are refused.
- An x86_64 distro with glibc 2.35 or newer (for example Ubuntu 22.04 or Debian 12).
- WSL environments exist only on Windows; other platforms do not show the section.

## Enabling a distro

Open **Settings → WSL**. It lists every installed distro with its state and WSL version,
except the utility distros that Docker Desktop and Rancher Desktop create for their
engines (`docker-desktop`, `docker-desktop-data`, `rancher-desktop` and
`rancher-desktop-data`), which cannot be enabled. Select **Enable** on the distro you want. Houston checks the WSL version, architecture
and glibc, copies its bundled Linux daemon into the distro under
`~/.local/lib/houston-wsl/`, and starts that daemon. When Houston cannot run in a distro,
the row names the reason, such as `WSL 1` or the glibc version found. **Retry** runs the
same steps again after you fix it.

Enabled distros are started again whenever Houston starts.

The distro's daemon keeps its state in the distro's own `~/.houston` directory, so a
Linux install of Houston inside the same distro shares that daemon and its sessions. If
that daemon runs a different build, Houston hands its sessions over to the bundled build
without ending them; if it speaks a newer protocol than this app, enabling is refused and
the reason names both versions.

## Disabling a distro

Select **Disable** and confirm. Houston stops its daemon inside that distro, which ends
every session that daemon owns, and the distro's workspaces leave the rail until you
enable it again. It also removes the `houston` command it added (below), but only if that
file is still Houston's own. If the daemon is still running afterwards, the row says so
and names its process ID.

## Opening a WSL folder

Use **Workspaces → + → Local folder…** and pick a folder under `\\wsl.localhost\<distro>\`
(or `\\wsl$\<distro>\`) in the folder picker. Houston adds the workspace to that
distro's environment with its Linux path, for example `/home/you/project`, and the rail
marks it with a penguin icon that reads `WSL: <distro>` on hover. Picking a folder from a
distro that is not enabled is refused with a message telling you to enable it in
Settings → WSL. A Linux path can belong to only one distro: opening the same path from a
second distro is refused.

New panes in a WSL workspace start inside the distro in that folder.

## `houston .` inside the distro

When Houston starts a distro's daemon, it also writes a `houston` command at
`~/.local/bin/houston` inside the distro, so `cd ~/project && houston .` opens and selects
that folder in the Windows app. It writes that file only when nothing is there yet or the
file is one Houston wrote earlier; an existing `houston` command (for example from a
Linux install of Houston) is left untouched. `~/.local/bin` must be on the distro's
`PATH`. If Houston is not running in the distro, the command says so.

## Agent CLIs and logins

Agents in a WSL workspace are the CLIs installed inside the distro, with the logins and
configuration stored there. Install and sign in to each agent CLI inside every distro
you use; Windows logins are not shared.

## What is not available for WSL workspaces

- **Orchestration across environments.** An agent in a distro can open and drive panes
  in that distro's workspaces, but not in Windows workspaces or other distros, and the
  reverse.
- **Tasks, projects, routines, harness review, Slack requests, dictation, and MCP and
  skill management** are handled by the Windows daemon and cover Windows workspaces
  only.
- **Browser tools** are not offered to agents running in a distro.
- **Tags** cannot be set on WSL panes.

## Files and editors

The Files panel reaches a WSL workspace through its `\\wsl.localhost\<distro>\` path.
That route is slower than a native disk on very large trees. Keep projects on the
distro's own file system (under `/home`), not on a Windows drive mounted under `/mnt/c`.

**Open in editor** opens WSL files in VS Code, VS Code Insiders, VSCodium, Cursor and
Windsurf through their remote WSL mode; other editors receive the `\\wsl.localhost`
path.

## Quitting

Closing the window leaves every environment's daemon and its sessions running. **Quit**
from the tray, or **Quit and stop daemon** from the command palette, stops the Windows
daemon and every enabled distro's daemon before Houston exits.

## What it transmits

Enabling a distro sends nothing over the network: Houston copies the daemon bundled in
its installer into the distro on this machine and talks to it through `wsl.exe`. Agent
CLIs inside the distro contact their own services as they would anywhere else.
