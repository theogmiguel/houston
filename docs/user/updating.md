# Updating Houston

Houston tells you when a newer release exists, and installs it when you click.

## The check

Settings ▸ About shows which Houston you are running — version, channel and the commit it
was built from — and whether a newer release has been published. Houston asks once when the
daemon starts, once a day after that, and whenever you press **Check now**.

The request goes to GitHub's releases API and asks one question: what is the latest
release. It carries nothing about you — not your version, not your operating system, not
any identifier — and nothing comes back except the release's own public details. Draft
releases are ignored, and so is a prerelease: a release candidate is cut as a tag and
installed by hand, never offered as an update.

**Switching it off.** Settings ▸ About ▸ *Check for updates*. Off means the request is
never made, and the panel says so rather than going quiet. The current value is always on
screen; nothing about this lives only in a file.

When a release is newer than what you are running, the panel names it, shows the start of
its notes, and offers **Install update** beside **Release notes** and **Later**. The bottom
of the sidebar says so too, beside the theme switch: a button carrying the new version
number, which opens this panel. It appears only while a newer release is waiting, and
**Later** puts it away until a release newer still comes along — the panel itself goes on
naming the release either way.

## Installing the update

**Install update** downloads the artifact published for the exact build you are running,
checks its signature against Houston's signing key, and only then installs it. The panel
shows the download's progress and the outcome. If anything does not line up — no artifact
for this build, a signature that does not verify, a manifest that moved on since the offer
was shown — nothing is installed and the panel says which of those it was.

## Linux

A `.deb` install runs your package manager's usual privileged install. An AppImage install
replaces the running file in place; Houston relaunches into the new one, or asks you to
quit and reopen it when it cannot.

Either way Houston then tries to move the running daemon onto the freshly installed build.
If that cannot be done, nothing is stopped: every session keeps running on the current
daemon and the panel says why. You can also install a downloaded `.deb` or `.AppImage`
yourself, exactly as you did the first time; Houston then attaches to the running daemon
as usual.

## Windows

**Install update** downloads the NSIS installer and runs it. The installer uninstalls the
previous version first, and Houston's own uninstall hook stops that old version's daemon
process as part of that step — matched by the process ID recorded for that install, never
by process name, so it can't affect an unrelated Houston install or channel.

Because the installer replaces the daemon binary, Houston refuses to update while the
channel's daemon has sessions running; close them and try again. The Windows installer is
not code-signed, so SmartScreen warns on first run. That is expected.

## What happens to running agents

Houston's daemon — the background process that owns your terminals — outlives the app
window. When the new app finds a daemon from another build, it asks that daemon to hand its
sessions to the daemon binary bundled with the new install. A successful handoff preserves
the sessions while moving the channel to the new build.

If a same-protocol handoff cannot complete, the app can continue against the running daemon
rather than interrupt its sessions. If the protocols differ, the app refuses to attach and
reports why; the old daemon and every session it owns remain unchanged. Finish or close those
sessions, then restart the daemon before opening the new app again.

To replace an idle daemon explicitly, launch Houston with `--daemon-fresh` from a terminal,
not from inside a Houston pane on the channel being restarted. It requests an orderly
shutdown, waits for the daemon to exit, then starts the installed binary; it does not
force-kill live sessions.

## From a terminal

`houston --version` prints the same version and commit the About panel shows, plus the wire
protocol number the app speaks. It starts nothing: no window, no daemon.

## Release notes

Each release's page lists what changed, generated from the pull requests that went into
it. The releases page is
[github.com/theogmiguel/houston/releases](https://github.com/theogmiguel/houston/releases).
