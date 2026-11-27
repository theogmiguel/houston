# Environments and task sources

Houston runs threads on a **server**. The app attaches to the server for its channel on
this machine, and can also reach servers on other machines as **environments**.

## Environments

**Settings ▸ Connections ▸ Environments** lists the environments this device can use.
**Add environment** offers:

- **Remote link** — enter the other machine's address and a pairing code.
- **SSH** — pick a host from your local SSH configuration and let Houston keep a tunnel.

A connected environment shows its version and endpoint, and can be removed from this device.
Removing it forgets its pairing and cached threads; switching it off keeps it saved.

Environments saved on this device, including their pairing tokens, are kept in one encrypted
file protected by the operating system: DPAPI on Windows and the Secret Service or KWallet on
Linux. If the system offers only plaintext storage, Houston refuses to
save an environment instead of writing it unencrypted. Environments saved by an earlier
version are moved into the encrypted file the first time the desktop app reads them, and the
older keychain entry is removed.

**Load balancing** chooses how new work is spread across environments by resources. **Pull
request sharing** chooses which trusted environments may read or act on pull requests with
this machine's credentials.

### Port forwarding

A thread can run a dev server or another TCP service in a remote environment and reach it from
this machine. Open the **Browser** tab and use **Forwarded ports**, or open a thread's details
and use **Servers**, enter the remote port and choose **Forward**. Opening a loopback server
that a thread in a remote environment started also forwards its port and opens it at
`http://127.0.0.1:<local port>`.

The list shows every forward this machine holds: the environment, the remote port, the local
port, its state and any error, with a **Stop** control. Each forward binds `127.0.0.1` only.
When the remote port is already taken locally, Houston picks the next free port in a bounded
window and shows the actual local port; it never reuses or stops the process holding it.

Nothing is forwarded without a user action for that port. An SSH environment forwards over
the SSH connection Houston already keeps; a linked environment forwards over its authenticated
connection, where the environment's server dials the service on its own loopback. A linked
environment holds up to 8 simultaneous connections per forward. This device holds up to 8
forwards per environment and 16 in all; a refused forward names the limit and the port it
requested, and a connection refused by a forward's per-connection limit is shown on its row.

**Settings ▸ Connections ▸ Port forwarding** turns the feature on and off and shows its current
value. While it is off, nothing is forwarded, every existing forward stops, and the controls say
why. Removing or disconnecting an environment stops its forwards, and quitting Houston stops
them all. Linux and Windows support the feature.

### Linked environments

**Settings ▸ Labs ▸ Linked environments** (beta, off by default) links this environment to the
user's other machines without adding them as environments. A thread can then hand work to an
agent on a linked machine, and the command palette searches that machine's threads alongside
this machine's.

A linked machine is named in **Settings ▸ Connections**, with its access and an **Unlink**
control. Its access limits what agents here may do there; **Full access** is required to connect
this window to that machine from a search result. Nothing is sent to a linked machine while the
beta is off.

**Link several…** appears once this device has two other environments saved. Tick the machines,
pick one access level for all of them and confirm once. A machine can be ticked when this app is
connected to it with a session that may create pairing codes there and has an address another
machine can reach; the list says why when it cannot. Each machine reports its own result, the
ones that failed stay ticked so you can retry only those, and machines already linked are left
as they are.

For machines this app is not connected to, put one `<address> <pairing-code>` per line in a file
(create each code with `houston pair` on that machine) and run
`houston environment link --from <file> --access <mode>`, or `--from -` to read standard input.
It prints one result per line without the pairing codes, leaves machines already linked as they
are, and exits non-zero when any line failed, so the same file can be run again with new codes
for the failures.

When you search the command palette, each linked machine receives the text you typed, once per
search, and answers with its matching thread titles and message excerpts. Nothing else leaves
this machine: no files, thread contents or credentials. A machine that is slow or does not
answer is named in the palette footer with **Retry**, and local results are never held back.
The excerpt is shown as text and never opens a link on this machine.

Choosing a match on a linked machine that is not connected here pairs this window with it. The
linked machine issues a one-time pairing code valid for three minutes, carrying no more than the
permissions this window already holds, and the thread opens when the connection is ready. A link
without **Full access** cannot issue that code; the palette names the required and actual access
and offers **Add environment** with the machine's address filled in. An expired link leads to
**Settings ▸ Connections** so it can be linked again with a new pairing code from that machine.

## Sharing and access

**Settings ▸ Connections ▸ Sharing & access** controls this machine's server:

- **Network access** — off means the server listens on `127.0.0.1` only; on lets other
  devices on the network pair with it.
- **Tailscale HTTPS** — serve over your tailnet with a Tailscale certificate.
- **Private transports only** — off by default. On, refuse remote connections that do not
  arrive over this machine, Tailscale or SSH; see [Encrypted remote control](#encrypted-remote-control).
- **End-to-end encryption** — off by default. On, encrypt the live session and show this host's
  fingerprint; see [Encrypted remote control](#encrypted-remote-control).
- **WSL backend** — on Windows, run WSL projects on a Houston server inside the distro, or run
  only that server. Changing the distro or WSL only restarts the affected server. The WSL
  backend is a separate environment: it keeps its own threads, projects and saved credentials,
  so sign in to providers and add source-control and other tokens again inside it. The WSL row
  in Settings shows whether it is running and, when it cannot start, why. It does not receive
  the desktop app's resource statistics, its in-app browser channel or its desktop update
  reports.
- **Pair a device** — create a pairing link or QR code.
- **Require approval for new devices** — off by default. On, a device that completes pairing
  waits in **Authorized clients** until you approve it; see below.
- **Authorized clients** — list paired devices, approve or deny devices waiting for approval, and
  revoke access.

Changing network access restarts the server. Existing tunnels keep working.

### Encrypted remote control

Controlling this server from another device sends prompts, files and agent output over the
network. Two optional switches in **Settings ▸ Connections ▸ Sharing & access** protect that
traffic. Both are off by default.

**Private transports only** refuses remote connections that do not arrive over this machine,
Tailscale or SSH. A tunnel, a public proxy or a plain LAN address gets a "not allowed" answer
before authentication. A connection that is already open stays open, and loopback (including an
SSH port-forward) always works, so you cannot lock yourself out. Turn it off from the same switch,
from a connected session, or from the server's `settings.json`.

**End-to-end encryption** encrypts the WebSocket session itself, so a tunnel or an untrusted
network only sees opaque data, and the device verifies this host's identity. The row shows the
host fingerprint, for example `AB12-CD34-EF56-7890`. To use it:

1. On the host, switch **End-to-end encryption** on.
2. Create a pairing link or QR code from this same section while it is on. The link carries the
   host's key, and the device saves it.
3. Connect as usual. A device that saved the key encrypts the whole session and refuses a host
   that presents a different key.

Good to know:

- Devices paired before you turned it on, or paired with a pairing code or a `houston pair` link,
  do not carry the key and therefore stay unencrypted.
- It cannot fail open. A device with a saved key either encrypts or does not connect. If you see
  an identity mismatch, the host's key changed; re-pair only if you expected that.
- Turning it off warns you: devices paired while it was on must pair again. Set `"e2eeMode":
  "require"` in the host's `settings.json` to also refuse remote devices that do not encrypt;
  loopback still connects.
- To replace the host key, stop the host, delete its `e2ee-identity-seed-v1` secret from the
  channel's secrets directory, start it again and re-pair every device.
- Only the live session is encrypted. File and image uploads and downloads, server-to-server
  linked environments, and agents that call the MCP endpoint use the connection itself, so use
  **Private transports only** with it when those matter.

### Device approval

**Require approval for new devices** in **Settings ▸ Connections ▸ Sharing & access** is off by
default, so pairing behaves as before. When it is on, a device that completes pairing with a
pairing link, QR code or pairing code appears under **Authorized clients** as waiting for
approval. It holds no permission at all: every request and every WebSocket method it makes is
refused with a message naming the device, this host and the setting. It cannot list clients,
approve itself or approve another device.

The pairing link printed when the server starts and the desktop app's own link are not subject
to approval. They belong to the person running the host, who would otherwise have no way to
approve their first device.

The host owner sees the device's name, when it paired, how it paired (link or code) and when its
approval expires, with **Approve** and **Deny**. The owner also gets an in-app notification when a
device starts waiting. Approving gives the device exactly the permissions the link or code
carried, never more; denying revokes its credential. A device that is not decided within 24 hours
expires, loses its credential and must pair again.

Turning the setting off does not approve devices already waiting: they stay pending until you
approve or deny them. Devices approved earlier keep working, and you can revoke any of them as
before. The WSL backend is a separate environment, so its server has its own setting and its own
pending devices.

## Use Houston from a phone

A paired phone browser uses the same server as the desktop app. Turn on **Network access**
and **Pair a device** under **Settings ▸ Connections ▸ Sharing & access**, then open the
pairing link in the phone's browser, or open the server's address and paste the pairing code.
The address must be reachable from the phone. A Tailscale HTTPS address (the tailnet's
MagicDNS name) is the recommended route: it provides the secure context that some browser
features require. A plain HTTP address on the local network works for pairing and chat, but
voice dictation, the install prompt and clipboard copy stay unavailable there because those
browser APIs require a secure context.

Install Houston to the home screen from the browser's menu; the page carries a web app
manifest and icons. With a secure context the installed copy opens without the browser's
address bar. A phone browser does not receive push notifications.

Below a 40rem viewport the phone layout covers threads, the composer (model, effort,
permissions, attachments, `@` file references and slash commands), approvals and questions,
the thread's Details, Files (read-only), Changes (commit and push), Pull requests, Usage and
Settings. A phone cannot use the terminal, the browser panel, tasks, file editing or drag and
drop.

## Use Houston in another app

Agents that Houston did not start, such as Claude Code or Codex in a terminal, can read
projects and threads and start, message and stop threads through Houston's MCP server. Open
the command palette (`Ctrl+K`, `Cmd+K` on macOS), search for **mcp**, and choose **Use Houston
in another app (MCP)**:

1. **App** — pick the agent, or **Something else…** for any app that supports remote MCP
   servers with OAuth. Apps that need their own client ID cannot connect.
2. **Access** — choose what it may do. **Read only** reads projects and threads;
   **Supervised** through **Full access** also start, message and stop threads, and none of
   them can run with more than the mode you pick. A level your session or your organization's
   policy does not allow is shown with the reason.
3. **Connect** — copy the address and the commands, run them where the agent runs, then choose
   **Get code** and paste the code on the sign-in page the agent opens.

A code works once, for 5 minutes, and approves only the level you chose. It cannot pair a
device or link an environment. Approved agents appear under **Authorized clients**, where you
can revoke them; a sign-in lasts 30 days.

The address is this environment's own address followed by `/mcp`. Agents sign in only over
`https` or `localhost`, so an agent on another machine needs an `https` address such as
[Tailscale HTTPS](#sharing-and-access). Apps hosted on the internet cannot reach an address
that is only on your machine or tailnet. Nothing in the wizard contacts a service outside this
machine.

## Task sources

**Settings ▸ Connections ▸ Task sources** configures where tasks come from:

- **Slack** — connect with an app token and a bot token, which Houston stores as secrets,
  set the owner whose white-check reaction starts a request, map up to 16 channels to
  projects, and choose the language for Houston's Slack text. A mapped channel turns a bot
  mention into a pending task. See [Tasks](tasks.md#sources).
- **Issue trackers** - Linear and Notion are connected under **Settings ▸ Source control**,
  where each project is bound to a team or data source and a Notion binding maps its
  properties. Tokens are stored as secrets. Every issue tracker is read on the **Issues**
  page, and a task is created from an issue.
- **Houston 1 data** - import Slack intake and Houston 1 Notion page links as issue-backed
  tasks.

## Secrets

**Settings ▸ Connections ▸ Secrets** manages secret providers, currently 1Password, used
as the source of a provider credential. A saved credential is never shown again; replace or
clear it instead.

Provider credentials and tokens are kept in the server's secret store, one file per secret
in the `secrets` folder of the channel's state directory, scoped to the channel, project and
provider. They are never written to the database, logs, traces or RPC replies. The store
needs no operating system keychain, so it works on servers and headless machines. The trade-off:
any process running as your user can read the files, and a backup of the state directory
includes them. Tokens an earlier version kept in the keychain are copied into the store at start, once the
keychain can be read; the keychain entries stay, and you can delete them yourself.
