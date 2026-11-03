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

## Task sources

**Settings ▸ Connections ▸ Task sources** configures where tasks come from:

- **Slack** — connect with an app token and a bot token, store them in the OS keychain,
  set the owner whose white-check reaction starts a request, map up to 16 channels to
  projects, and choose the language for Houston's Slack text. A mapped channel turns a bot
  mention into a pending task. See [Tasks](tasks.md#sources).
- **Project sources** — for one project, connect GitHub issues (repository, label,
  assigned user, token) or Notion (integration token, tasks data source, assignee, active
  statuses and property mapping). Tokens are stored in the keychain.
- **Houston 1 data** — import task-source settings and links from Houston 1.

## Secrets

**Settings ▸ Connections ▸ Secrets** manages secret providers, currently 1Password, used
as the source of a provider credential. A saved credential is never shown again; replace or
clear it instead.

Provider credentials and tokens are kept in the operating system keychain, scoped to the
channel, project and provider. They are never written to the database, logs, traces or RPC
replies.
