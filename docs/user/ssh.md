# SSH

## What this is, and what it isn't

An SSH pane opens a remote shell on another host as a normal pane in your grid — not a
remote workspace. Only that one shell runs on the remote host; the daemon, every other
pane, and the rest of Houston stay on this machine. A workspace is still a local project
directory: SSH gives you a pane that happens to run somewhere else, not a way to point a
whole workspace at a remote machine.

## Connecting

Open **Workspaces → + → Connect via SSH…** and enter a machine hostname, IP address,
or SSH configuration name. Username is optional: Houston uses the configured User or
your local account name.
Houston reads HostName, User, Port and IdentityFile in Host blocks; ProxyJump, Match and
Include are not supported. Host aliases and wildcard defaults apply with every
authentication method, including a key selected at connect time. The first matching
value wins, as in OpenSSH.

The Folder field selects the remote starting directory. `~` and `~/` resolve to the
remote home directory; spaces and shell metacharacters in the path remain literal.

Expand **Advanced** to change the port or enable **Choose an SSH key when connecting**.
Connect then opens the native private-key picker; cancelling it leaves the connection
unopened. Otherwise Houston uses the identity named in your SSH configuration or your
local SSH agent.

The first time you connect to a host, Houston shows you its key fingerprint to accept —
trust-on-first-use, recorded in a known_hosts file of its own. If the host's key ever
changes afterward, you're shown the new fingerprint next to the one you trusted before,
so you can tell a legitimate rekey from something worth walking away from.

## What doesn't work over SSH

Shell integration is a deliberate non-goal for SSH panes: Houston does not install its
shell-prompt marker across the SSH hop, so the working-directory and command tracking
that plain local shell panes get do not apply to a remote shell. Everything else about
the pane — scrollback, resizing, closing — works the same as a local terminal pane.

You can also send a local file up to the connected host from the pane, streamed rather
than held in memory, which is the one other operation an SSH pane supports beyond a
shell.

There is no auto-reconnect: if the connection drops, you reconnect the pane yourself.
