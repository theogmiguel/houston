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

**Load balancing** chooses how new work is spread across environments by resources. **Pull
request sharing** chooses which trusted environments may read or act on pull requests with
this machine's credentials.

## Sharing and access

**Settings ▸ Connections ▸ Sharing & access** controls this machine's server:

- **Network access** — off means the server listens on `127.0.0.1` only; on lets other
  devices on the network pair with it.
- **Tailscale HTTPS** — serve over your tailnet with a Tailscale certificate.
- **WSL backend** — on Windows, run WSL projects inside the distro, optionally WSL only.
- **Pair a device** — create a pairing link or QR code.
- **Authorized clients** — list paired devices and revoke their access.

Changing network access restarts the server. Existing tunnels keep working.

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
- **Project sources** — for one project, connect GitHub issues (repository, label,
  assigned user, token) or Notion (integration token, tasks data source, assignee, active
  statuses and property mapping). Tokens are stored as secrets.
- **Houston 1 data** — import task-source settings and links from Houston 1.

## Secrets

**Settings ▸ Connections ▸ Secrets** manages secret providers, currently 1Password, used
as the source of a provider credential. A saved credential is never shown again; replace or
clear it instead.

Provider credentials and tokens are kept in the server's secret store, one file per secret
in the `secrets` folder of the channel's state directory, scoped to the channel, project and
provider. They are never written to the database, logs, traces or RPC replies. The store
needs no operating system keychain, so it works on servers and headless machines. The trade-off:
any process running as your user can read the files, and a backup of the state directory
includes them. Tokens an earlier version kept in the keychain are copied into the store on
first start; the keychain entries stay, and you can delete them yourself.
