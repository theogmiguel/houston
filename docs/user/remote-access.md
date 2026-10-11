# Remote access

Remote access lets you follow and answer your panes from a phone or another computer. A
paired device lists every pane with its reported status, panes that need you first, and
shows each pane as a conversation: your prompts, the agent's replies, its tool steps, and
the questions and permission requests it is waiting on, which you answer with a tap. The
pane menu offers **View screen**, and you can type a message or press keys such as
Enter, Esc, the arrow keys, Tab and Ctrl+C. Optionally, Houston sends a push notification
through [ntfy](https://ntfy.sh) when an agent has been waiting for input for a while.

Remote access is off by default. While it is off, nothing listens and nothing is sent.

## What a paired device can do

A paired device can read the screen of any pane and type into any pane, including shell
panes. That is as much access as a shell on this computer as your user: treat a paired
device, and the link it was paired with, like an unlocked terminal. A device cannot pair
other devices, change settings, open or close panes. Revoke a device you lose straight away.

**View screen** is a read-only text snapshot of the last 40 lines that refreshes while the
sheet is open. Its key row sends input to the pane; the snapshot never resizes or takes
over the pane on your desktop. **Computer ▸ Screen text size** changes its text size on
this device.

The conversation comes only from what each agent CLI reports through its hooks while remote
access is on: prompts, final replies, questions and their options, and for each permission
request or tool step the tool's name and one target (a command, file path, URL or pattern).
Secrets that match Houston's credential patterns are masked, long text is shortened, and
nothing of it is saved: it is kept in memory and is gone when the daemon stops. Turning remote
access off clears it, and nothing is collected while it is off, so activity from before
remote access was last turned on is only in **View screen**.

Activity lists recent finished turns, requests that need you and answers across panes.
Answers identify whether they came from the phone or the terminal. Like conversations,
activity is kept only in memory while remote access is on and clears when it is turned off.

## Turn it on

Choose **Connect phone** from the rail footer or command palette, or open
**Settings ▸ Remote access ▸ Connect phone**. The dialog explains the access a paired
device receives. Choose a route, enter its public URL, then choose **Enable remote access**.
You can also turn on **Allow remote access** directly in Settings ▸ Remote access. By default, Houston listens on
`127.0.0.1:47823` (`127.0.0.1:47824` for a development build), which only this computer can
reach. The **Status** row shows the address devices open, or why Houston could not listen.

### Reach it from your phone with Tailscale (recommended)

[Tailscale](https://tailscale.com) gives the listener an HTTPS address that only your own
devices can open, without opening a port to the internet:

1. Install Tailscale on this computer and on your phone, signed in to the same tailnet,
   with MagicDNS and HTTPS certificates turned on in the tailnet settings.
2. On this computer, run `tailscale serve --bg 47823`. Tailscale prints an address such as
   `https://machine.tailnet.ts.net`. On Linux, running it without root needs
   `sudo tailscale set --operator=$USER` once.
3. Paste that address into **Public URL** in Settings ▸ Remote access.

The machine name becomes part of a public certificate log; rename the machine in Tailscale
first if its name is sensitive. Do not use `tailscale funnel`: it would publish the
listener to the whole internet.

### Other addresses

**Settings ▸ Remote access ▸ Advanced ▸ Listen address** accepts another `IP:PORT`, such
as this computer's Tailscale or LAN address. Listening on every interface (`0.0.0.0`) requires a **Public URL** that names the
address devices open. Without HTTPS in front, a device's token and the pane text it reads
cross the network unencrypted, and Settings shows a warning.

### Choose the route in Connect phone

**Tailscale (works anywhere, HTTPS)** keeps Houston on `127.0.0.1` at its configured
port. Choose **Copy command**, run the shown `tailscale serve --bg <port>` command on
this computer, and paste the HTTPS address it prints into **HTTPS public URL**. Houston
does not detect or install Tailscale. Both devices must be on the same tailnet.

**Same Wi-Fi (plain HTTP)** sets the listen address to `0.0.0.0` at the configured port.
Enter this computer's LAN address and that port in **LAN public URL**, such as
`http://192.168.1.20:47823`. Use a trusted network: device tokens and pane text cross it
unencrypted. Your phone must be able to reach this computer; the dialog cannot discover
its LAN address. Choose **Apply route** when remote access is already on.

The QR code appears once Houston reports that the listener is ready at the selected
address. Scan it with the phone camera, or choose **Copy link**. It works once and the
countdown shows when it expires; choose **Get a new code** after expiry. Confirm on the
phone to see **<device> is connected** on the desktop. Choose **Connect another** for
another code or **Done** to close. Closing the dialog keeps remote access on. Listen
address and public URL remain available under **Settings ▸ Remote access ▸ Advanced**.

The paired device can show this computer's name and Houston version, together with the
remote access address and whether that address uses HTTPS.

## Pair a device

1. In Settings ▸ Remote access, choose **Pair a device**. Houston shows a QR code and a
   link that work once and expire after 10 minutes.
2. Scan the code with the phone's camera, or open the link on the other computer.
3. Confirm the suggested device name or enter another, then choose **Connect this phone**.
   The device is listed under **Devices** with the time it was last seen.
4. Follow the browser-specific installation steps if you want a home-screen shortcut,
   then choose **Open Houston**. These steps are also in **Computer ▸ App**.

On a phone, use the browser's **Add to Home Screen** to open Houston like an app. Each
browser keeps its own pairing; a device that lost its pairing (for example, after clearing
site data) asks to be paired again.

## Answer an agent

The phone has four tabs:

- **Inbox** shows one request at a time. Use the arrows to move between requests. When
  nothing needs you, it shows working panes and recent replies.
- **Panes** lists tiles, with waiting panes first, followed by working and idle panes.
  Workspace chips show counts and an amber dot when a pane there needs you. The workspace
  choice is remembered on this device.
- **Activity** shows recent finishes, requests and answers across panes. Tap an entry to
  open its conversation near that event. Older entries may have left the conversation's
  bounded history. Computers without activity support show an availability message.
- **Computer** shows the host, connection route and device name. Vibration, quick replies
  and screen text size are device-local preferences; notifications and remote access
  settings are configured on the computer.

The page title counts waiting panes. Android can vibrate for a new request while Houston
is open. When the connection drops, the last state is dimmed and answers are disabled.
After about 30 seconds, the page offers **Retry** and suggests checking whether the
computer is asleep. Live updates use a stream, with polling when the stream is unavailable.

A permission request in **Inbox** shows the tool and its whole target with **Approve**
and **Deny**, so you can answer without opening the pane. When Houston can show only part of
the command, because it is very long or contains invisible formatting characters, the
request offers **Open terminal** instead. This opens **View screen**; read the full
request on the computer if it is not all visible in the snapshot. Inside a pane, the
request waiting on you is a card above the message box:

- **Permission:** **Approve**, **Deny**, and **Always** when the CLI offers to stop asking
  for similar requests.
- **Question:** in Inbox, tap an option to send it. In a pane, select an option and choose
  **Next**. Choose **Other…** to type your own answer in the message box.
  Questions whose options carry previews offer no **Other…**; type that answer in the
  terminal.

After a tap the card shows **Sent** and takes no further tap until the agent moves on, which
for an approved command can be when the command finishes. Houston answers by typing the same
keys you would press in the terminal; when a key reaches the pane from the desktop or the key
row after the request arrived, the card shows **Already answered in the terminal** and offers only
**View screen**. If the request changed before your tap arrived, or remote access was
turned off and on since the page loaded, Houston refuses the tap instead of answering the
wrong request.

Claude edit permission cards also show the file path and a masked preview of removed and
added lines. Large previews are shortened; approve those in the pane's terminal after
reviewing the full request, or deny from the phone.

Cards you can answer with a tap are available for Claude Code permission requests and
single questions with one answer. Questions with several parts or several answers, and
requests from Codex, Cursor, Grok, OpenCode and Antigravity, show a waiting card with
**View screen** and the key row; replies and status still appear in their conversation.

Each pane shows user messages, agent replies and a work log. Claude tool calls that fail
remain in the log and count toward the turn summary; listed edit paths include attempted
edits even when the tool failed. When the computer reports a
turn end, the log folds into a summary with its duration and changed files. Tap the summary
to reopen it. Older computers show the tool steps without a duration or changed-file card.
Child panes appear together
when the computer reports their relationship, and a child that needs you has an **Open**
band. Quick replies appear while idle after a finished turn and fill the message box without sending.

The message box sends your text and presses Enter. Multi-line text works only when the
program in the pane accepts pasted text; otherwise send one line at a time. The keys button shows the
key row: **Esc**, the arrow keys, **Tab**, **Enter**, and **Ctrl+C**, which asks for a second
tap before it interrupts the agent. While an agent works and the message box is empty,
the send button becomes **Stop**: tap twice to send Esc. The conversation records that
this phone requested a stop; the agent's reported status determines whether it stopped.
Messages typed while working go directly to the pane. The phone does not queue or steer
messages. For a permission request, choose **Deny** first and then send your explanation;
the computer cannot attach a typed reason to a denial. Pane renaming and focusing on the
computer are available from the desktop application.

## Notifications with ntfy

1. Install the ntfy app on your phone and subscribe to a topic with a long, unguessable
   name. Anyone who knows the topic name can read its messages.
2. Paste the topic URL, such as `https://ntfy.sh/<topic>`, into **ntfy topic URL** in
   Settings ▸ Remote access and choose **Save**. The URL is kept in the OS keychain; the
   settings show only the server.
3. Adjust **Delay** (30 seconds by default, up to 600). A pane must keep waiting for that
   long before the notification goes out; if you answer on the desktop sooner, nothing is
   sent. Each time a pane starts waiting, at most one notification is sent.

Tapping a notification with a pane link opens that pane on the paired device. A late link
shows **Already answered** when the conversation reports an answer, or **No request
waiting** when no decision remains. **Also when a turn finishes**
adds a notification when a working agent settles at idle.

### What is sent

While remote access is on and a topic URL is set, Houston posts to the ntfy server you
chose: the title "Houston", the message "An agent needs your input" (or, with **Include
the pane name**, the pane's title, which a program can set), and a link to your remote
access address with the pane id in its fragment (`#session=<id>`). Terminal content, commands and file paths are never sent. With the public
ntfy.sh server, ntfy's operator can read these messages; a self-hosted ntfy server keeps
them on your server.

## Revoke a device or turn it off

**Computer ▸ Disconnect this device** forgets this browser's token and clears its displayed
conversations. It does not revoke the token on the computer: use **Settings ▸ Remote
access ▸ Devices ▸ Revoke** there to revoke access. Pair again to reconnect this browser.

Choose **Revoke** next to a device (and confirm) to end its access immediately, including a
page it has open. A connected phone receives an explicit reason when its device is revoked
or remote access is disabled. Turning off **Allow remote access** stops the listener, closes open pages'
live updates, clears the conversations and stops notifications; paired devices stay listed
and work again when you turn it back on. To stop notifications only, choose **Turn off**
next to the topic URL.

## Platforms

Remote access works the same on Linux and Windows. On Windows, Houston has no terminal
emulator in the daemon, so a device sees the pane's recent raw output instead of its
rendered screen, and multi-line answers are refused.
