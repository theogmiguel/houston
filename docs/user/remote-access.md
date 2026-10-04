# Remote access

Remote access lets you follow and answer your panes from a phone or another computer. A
paired device lists every pane with its reported status, panes that need you first, and
shows each pane as a conversation: your prompts, the agent's replies, its tool steps, and
the questions and permission requests it is waiting on, which you answer with a tap. A
Terminal tab shows the pane's screen, and you can type a message or press keys such as
Enter, Esc, the arrow keys, Tab and Ctrl+C. Optionally, Houston sends a push notification
through [ntfy](https://ntfy.sh) when an agent has been waiting for input for a while.

Remote access is off by default. While it is off, nothing listens and nothing is sent.

## What a paired device can do

A paired device can read the screen of any pane and type into any pane, including shell
panes. That is as much access as a shell on this computer as your user: treat a paired
device, and the link it was paired with, like an unlocked terminal. A device cannot pair
other devices, change settings, open or close panes. Revoke a device you lose straight away.

The Terminal tab is a text snapshot that refreshes while the tab is open; it is not an
interactive terminal, and it never resizes or takes over the pane on your desktop.

The conversation comes only from what each agent CLI reports through its hooks while remote
access is on: prompts, final replies, questions and their options, and for each permission
request or tool step the tool's name and one target (a command, file path, URL or pattern).
Secrets that match Houston's credential patterns are masked, long text is shortened, and
nothing of it is saved: it is kept in memory and is gone when the daemon stops. Turning remote
access off clears it, and nothing is collected while it is off, so activity from before
remote access was last turned on is only in the Terminal tab.

## Turn it on

Open **Settings ▸ Remote access** and turn on **Allow remote access**. Houston listens on
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

**Listen address** accepts another `IP:PORT`, such as this computer's Tailscale or LAN
address. Listening on every interface (`0.0.0.0`) requires a **Public URL** that names the
address devices open. Without HTTPS in front, a device's token and the pane text it reads
cross the network unencrypted, and Settings shows a warning.

## Pair a device

1. In Settings ▸ Remote access, choose **Pair a device**. Houston shows a QR code and a
   link that work once and expire after 10 minutes.
2. Scan the code with the phone's camera, or open the link on the other computer.
3. Name the device and choose **Pair**. The device is listed under **Devices** with the
   time it was last seen.

On a phone, use the browser's **Add to Home Screen** to open Houston like an app. Each
browser keeps its own pairing; a device that lost its pairing (for example, after clearing
site data) asks to be paired again.

## Answer an agent

The home screen groups panes into **Needs you**, **Working** (with the agent's latest step)
and **Idle** (with the start of its last reply); with panes in more than one workspace, the
chips at the top filter by workspace. The page title counts the panes that need you, and an
Android phone vibrates briefly when a new request arrives while Houston is open. The dot
next to the title shows whether updates are live or reconnecting.

A permission request in **Needs you** shows the tool and its whole target with **Approve**
and **Deny**, so you can answer without opening the pane. When Houston can show only part of
the command, because it is very long or contains invisible formatting characters, the
request offers **Open terminal** instead: read and approve it there. Inside a pane, the
request waiting on you is a card above the message box:

- **Permission:** **Approve**, **Deny**, and **Always** when the CLI offers to stop asking
  for similar requests.
- **Question:** tap an option, or **Other…** to type your own answer in the message box.

After a tap the card shows **Sent** and takes no further tap until the agent moves on, which
for an approved command can be when the command finishes. Houston answers by typing the same
keys you would press in the terminal; when a key reaches the pane from the desktop or the key
row after the request arrived, the card shows **Answered in the terminal** and offers only
**Open terminal**. If the request changed before your tap arrived, or remote access was
turned off and on since the page loaded, Houston refuses the tap instead of answering the
wrong request.

Cards you can answer with a tap are available for Claude Code permission requests and
single questions with one answer. Questions with several parts or several answers, and
requests from Codex, Cursor, Grok, OpenCode and Antigravity, show a **Needs you** card with
**Open terminal** and the key row; replies and status still appear in their conversation.

The message box sends your text and presses Enter. Multi-line text works only when the
program in the pane accepts pasted text; otherwise send one line at a time. **+** shows the
key row: **Esc**, the arrow keys, **Tab**, **Enter**, and **Ctrl+C**, which asks for a second
tap before it interrupts the agent.

## Notifications with ntfy

1. Install the ntfy app on your phone and subscribe to a topic with a long, unguessable
   name. Anyone who knows the topic name can read its messages.
2. Paste the topic URL, such as `https://ntfy.sh/<topic>`, into **ntfy topic URL** in
   Settings ▸ Remote access and choose **Save**. The URL is kept in the OS keychain; the
   settings show only the server.
3. Adjust **Delay** (30 seconds by default, up to 600). A pane must keep waiting for that
   long before the notification goes out; if you answer on the desktop sooner, nothing is
   sent. Each time a pane starts waiting, at most one notification is sent.

Tapping the notification opens that pane on the paired device. **Also when a turn finishes**
adds a notification when a working agent settles at idle.

### What is sent

While remote access is on and a topic URL is set, Houston posts to the ntfy server you
chose: the title "Houston", the message "An agent needs your input" (or, with **Include
the pane name**, the pane's title, which a program can set), and a link to your remote
access address. Terminal content, commands and file paths are never sent. With the public
ntfy.sh server, ntfy's operator can read these messages; a self-hosted ntfy server keeps
them on your server.

## Revoke a device or turn it off

Choose **Revoke** next to a device (and confirm) to end its access immediately, including a
page it has open. Turning off **Allow remote access** stops the listener, closes open pages'
live updates, clears the conversations and stops notifications; paired devices stay listed
and work again when you turn it back on. To stop notifications only, choose **Turn off**
next to the topic URL.

## Platforms

Remote access works the same on Linux and Windows. On Windows, Houston has no terminal
emulator in the daemon, so a device sees the pane's recent raw output instead of its
rendered screen, and multi-line answers are refused.
