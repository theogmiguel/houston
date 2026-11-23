# Updating Houston

Houston checks for a newer release and installs it when you click.

## The check

**Settings ▸ About** and the update button in the sidebar footer show whether a newer release
is published; both offer the same actions. Houston checks about 15 seconds after start and then
every four hours, and **Check for Updates** runs one now. Checking is passive: installing always
needs your click, and a check never hides an update that is already offered or downloaded.

The request reads the public `latest*.yml` update feed attached to the project's GitHub
releases. It carries nothing about you and ignores prereleases.

When a newer release exists, the row offers **Download** and then **Install**. **Release
notes** opens the release page. A failed check or download shows the reason instead of
silently doing nothing.

## Installing

**Download** fetches the update for this platform and installer and checks it against the
checksum in the update feed. **Install** (**Restart to update** in the sidebar) asks for
confirmation and restarts the app on the new version. A download or install that is refused or
fails says so and names the cause, including an install that fails after the app began to quit.
When a newer release appears after a download, the downloaded build stays installable and the
newer one is offered after the restart.

The sidebar's update popover keeps the app's own action separate from **Update everything**,
which also updates agent providers and connected servers. Restarting the app never waits for a
remote server to finish its update; that update continues on its own machine.

On Linux, the AppImage keeps the name `Houston-<arch>.AppImage`, so an update replaces the file
in place and launchers that point at it keep working. An install from an earlier build with the
version in its file name moves to that name once, on its next update.

Installing restarts Houston, which stops the server it started and ends its running agents;
finish work you want to keep first. If a server from another build is still
running when Houston starts, Houston attaches to it, warns that its version differs from
the app's, and never stops it; quit that server yourself to run the server bundled with the
new build.

## Coming from Houston 1

Houston 2 installs as the same application as Houston 1, so it replaces it without a separate
migration step. Houston 2 keeps its own data in the channel directory's `v2` child and never
changes Houston 1's files.

On each start, Houston stops Houston 1's daemon unit for the channel and removes the
hook and MCP entries Houston 1 added to Claude, Codex, OpenCode, Antigravity and ZCode. The
removal stands down while a Houston 1 daemon is still running, because that daemon would
reinstall its entries at startup; **Settings ▸ Maintenance** shows the outcome and names
anything that still needs you to quit Houston 1.

Houston 1 conversations are not imported. A one-time, read-only import copies:

- projects from Houston 1 workspaces that still exist on disk;
- the Tasks backlog and its settings;
- task-source settings and links, and Slack intake.

With no projects, the first screen offers **Import N projects from Houston 1**; the
import also lives in **Settings ▸ Maintenance** under **Coming from Houston 1**.

The import reads Houston 1's `houston.db` and leaves it untouched. It refuses to copy tasks
into a v2 backlog that already has tasks rather than merging two unrelated numbering
schemes. A value that cannot be carried over is named, such as a Houston 1 agent with no
Houston 2 provider or a workspace that no longer exists. A failed import shows the server's
message in the same section.

Houston 1's routines, Night shift runs and Harness reviews are not imported. Recurring work
uses **Settings ▸ Scheduled tasks** instead.

## From a terminal

`houston --version` prints the version the About panel shows.
