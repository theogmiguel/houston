# Updating Houston

Houston checks for a newer release and installs it when you click.

## The check

**Settings ▸ About** shows the version and whether a newer release is published. Houston
checks about 15 seconds after start and then every four minutes, and **Check for Updates**
runs one now. Checking is passive: installing always needs your click.

The request reads the public `latest*.yml` update feed attached to the project's GitHub
releases. It carries nothing about you and ignores prereleases.

When a newer release exists, the row offers **Download** and then **Install**. **Release
notes** opens the release page. A failed check or download shows the reason instead of
silently doing nothing.

## Installing

**Download** fetches the update for this platform and installer and checks it against the
checksum in the update feed. **Install** asks for confirmation and restarts the app on the
new version. A failed download or install shows the cause.

Closing the window does not stop the server. If a server from another build is still
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

Houston 1 conversations are not imported. A one-time, read-only import in **Settings ▸
Maintenance** under **Coming from Houston 1** copies:

- projects from Houston 1 workspaces that still exist on disk;
- the Tasks backlog and its settings;
- task-source settings and links, and Slack intake.

The import reads Houston 1's `houston.db` and leaves it untouched. It refuses to copy tasks
into a v2 backlog that already has tasks rather than merging two unrelated numbering
schemes. A value that cannot be carried over is named, such as a Houston 1 agent with no
Houston 2 provider or a workspace that no longer exists. A failed import shows the server's
message in the same section.

Houston 1's routines, Night shift runs and Harness reviews are not imported. Recurring work
uses **Settings ▸ Scheduled tasks** instead.

## From a terminal

`houston --version` prints the version the About panel shows.
