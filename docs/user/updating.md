# Updating Houston

Houston checks for a newer release and installs it when you click.

## The check

**Settings ▸ About** shows the version and whether a newer release is published. Houston
checks about 15 seconds after start and then every four minutes, and **Check for Updates**
runs one now. Checking is passive: installing always needs your click.

The request fetches the public `latest.json` manifest from the project's GitHub releases. It
is not a GitHub API call, carries nothing about you and ignores prereleases.

When a newer release exists, the row offers **Download** and then **Install**. **Release
notes** opens the release page. A failed check or download shows the reason instead of
silently doing nothing.

## Installing

**Install** asks for confirmation, downloads the update for this platform and installer,
and verifies its signature before installing. A missing artifact, a bad signature or a
manifest that moved on stops the install and names the cause. The app restarts on the new
version.

Closing the window does not stop the server. After an update, the next launch finds a
detached server left by another build, stops it and starts the server bundled with the new
build, so its running agent runs end. Finish work you want to keep before updating a machine
whose server is running agents.

## Coming from Houston 1

Houston 2 installs as the same application as Houston 1, so it replaces it without a separate
migration step. Houston 2 keeps its own data in the channel directory's `v2` child and never
changes Houston 1's files.

On the first start, Houston stops Houston 1's daemon unit for the channel and removes the
hook and MCP entries Houston 1 added to Claude, Codex, OpenCode, Antigravity and ZCode. The
removal stands down while a Houston 1 daemon is still running, because that daemon would
reinstall its entries at startup; **Settings ▸ Maintenance** shows the outcome and names
anything that still needs you to quit Houston 1.

Houston 1 conversations import automatically on first start. The rest is a one-time,
read-only import in **Settings ▸ Maintenance** under **Coming from Houston 1**:

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
