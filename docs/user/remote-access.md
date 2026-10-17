# Remote access

Remote access lets you follow and answer your panes from a phone or another computer. A
paired device lists root agents and ordinary terminals with their reported status and
shows each pane as a conversation: your prompts, the agent's replies, its tool steps, and
the questions and permission requests it is waiting on, which you answer with a tap. The
pane menu offers **View screen**, and you can type a message or press keys such as
Enter, Esc, the arrow keys, Tab and Ctrl+C. Optionally, Houston sends a push notification
through [ntfy](https://ntfy.sh) when an agent has been waiting for input for a while.

Remote access is off by default. While it is off, nothing listens and nothing is sent.

## What a paired device can do

At the default tier a paired device can read the screen of any pane and type into any pane,
including shell panes. That is as much access as a shell on this computer as your user: treat
a paired device, and the link it was paired with, like an unlocked terminal. At every tier a
device cannot pair other devices, change settings or revoke devices; those stay on this
computer. Revoke a device you lose straight away.

### Device tiers

Each paired device has a tier, shown beside its name under **Settings ▸ Phone & remote
access ▸ Paired devices**. Each tier includes the one before it:

| Tier | The device can |
|---|---|
| **Observe** | Read panes, their conversations and screens, activity and status. It cannot type, answer a request or dictate. |
| **Drive** | Also type and press keys, answer permission requests and questions, and dictate. |
| **Manage** | Also open, rename, restart, sleep, wake and close panes, and commit or push a pane's changes. |

Devices paired before tiers existed, and every new pairing, are **Drive**. Choose another
tier from the device's selector; choosing the previous one reverses it. A change applies on
the device's next request, and a request above the device's tier is refused with a message
naming the tier it needs.

**View screen**, in a pane's **⋯** menu, is a read-only text snapshot of the last 40 lines that refreshes while the
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
Closing or respawning a pane clears its old conversation and pending notifications.
An exited pane keeps its conversation until it is closed or respawned.

Activity lists recent finished turns, requests that need you and answers across panes.
Answers identify whether they came from the phone or the terminal. Like conversations,
activity is kept only in memory while remote access is on and clears when it is turned off.

The Panes grid, workspace filters and the Inbox's working and last-finished lists show
root agents and ordinary terminals. Open an orchestrator to see and open its children,
including children in separate worktrees. Child requests that need you still appear in
the Inbox. Provider avatars show the provider alone; status appears beside them.

## Turn it on

Open **Settings ▸ Phone & remote access** and choose **Show pairing code**. The code
appears inline when the daemon confirms that the configured listener is ready. If a route
has not been configured, Houston opens the route dialog first; choose a route, enter its
address, then choose **Turn on and show code**. **Use another route** opens that dialog
at any time. The command palette's **Connect phone** command also opens the dialog.

Under the collapsed **Route and address** row, **Allow remote access** turns the listener
on or off and shows its reported address or error. By default, Houston listens on
`127.0.0.1:47823` (`127.0.0.1:47824` for a development build), which only this computer can
reach. Houston does not detect or install Tailscale.

### Reach it from your phone with Tailscale (recommended)

[Tailscale](https://tailscale.com) gives the listener an HTTPS address that only your own
devices can open, without opening a port to the internet:

1. Install Tailscale on this computer and on your phone, signed in to the same tailnet,
   with MagicDNS and HTTPS certificates turned on in the tailnet settings.
2. On this computer, run `tailscale serve --bg 47823`. Tailscale prints an address such as
   `https://machine.tailnet.ts.net`. On Linux, running it without root needs
   `sudo tailscale set --operator=$USER` once.
3. Paste that address into **Address** in **Settings ▸ Phone & remote access ▸ Route and address ▸ Route ▸ Change…**.

The machine name becomes part of a public certificate log; rename the machine in Tailscale
first if its name is sensitive. Do not use `tailscale funnel`: it would publish the
listener to the whole internet.

### Other addresses

**Settings ▸ Phone & remote access ▸ Route and address ▸ Listen address ▸ Edit…** accepts another `IP:PORT`, such
as this computer's Tailscale or LAN address. Listening on every interface (`0.0.0.0`) requires a public URL, set under **Route**, that names the
address devices open. The **Route** row reads Tailscale, Same Wi-Fi or Custom. On a private
address (`10.x`, `172.16–31.x`, `192.168.x`, or a `.local` name for a listener on every
interface), Houston serves HTTPS itself with this computer's certificate (see
[The certificate](#the-certificate)). On any other address without HTTPS in front, a device's
token and the pane text it reads cross the network unencrypted, and the **Route** row shows a
warning.

### Connect phone

When remote access is already on with a public URL, the dialog opens on the code;
**Settings ▸ Phone & remote access ▸ Route and address ▸ Route ▸ Change…** opens it on the route.

**Connect a phone.** Choose a **Route**:

- **Tailscale · HTTPS** keeps Houston on `127.0.0.1` at its configured port. Choose
  **Copy**, run the shown `tailscale serve --bg <port>` command on this computer, and
  paste the HTTPS address it prints into **Address**. Houston does not detect or install
  Tailscale. Both devices must be on the same tailnet.
- **Same Wi-Fi · HTTPS** sets the listen address to `0.0.0.0` at the configured port.
  Enter this computer's LAN address and that port in **Address**, such as
  `https://192.168.1.20:47823`; it must be a private address or a `.local` name. Houston
  serves HTTPS with its own certificate, which the phone trusts once (see
  [The certificate](#the-certificate)). Your phone must be able to reach this computer; the
  dialog cannot discover its LAN address.

Choose **Turn on and show code**, or **Show code** when remote access is already on with
that route. If Houston cannot listen or the address is not valid, the reason appears under
**Address**.

**Scan with your phone.** The QR code appears once Houston reports that the listener is
ready at the selected address. Scan it with the phone camera, or choose **Copy link**. It
works once and the countdown shows when it expires; after expiry the code is dimmed and
**Get a new code** replaces it. The bottom-left button shows the current route and host;
choose it to change the route. With **Same Wi-Fi**, the dialog also shows the certificate's
fingerprint: the first time, the phone warns that the connection is not private; continue to
the page and follow **Trust this computer** there.

**Connected.** Confirm on the phone to see **<device> is connected** on the desktop.
Choose **Connect another** for another code or **Done** to close. Closing the dialog keeps
remote access on. The route and listen address remain available under **Settings ▸ Phone & remote access ▸
Route and address**.

The paired device can show this computer's name and Houston version, together with the
remote access address and whether that address uses HTTPS.

### The certificate

When devices reach Houston directly on a private address, as with **Same Wi-Fi**, Houston
serves remote access over HTTPS only, with a certificate signed by a certificate authority it
creates the first time it is needed. The authority's private key stays in the OS keychain. It
can certify only private network addresses (`10.x`, `172.16–31.x`, `192.168.x`, loopback and
IPv6 unique-local) and `.local` names, so it cannot be used to impersonate a public website.
Its fingerprint is shown under **Settings ▸ Phone & remote access ▸ Route and address ▸ Certificate**. With the Tailscale
route, Tailscale provides the HTTPS certificate and none of this applies.

A device trusts the authority once; when the listen address changes, Houston issues a new
certificate from the same authority and the device keeps trusting it. Until a device trusts
it, the browser warns about the site: you can continue past the warning to pair and download
the certificate, but the microphone and the home-screen app need it trusted.

On the pairing page, compare the fingerprint it shows with Settings, then:

- **Android:** tap **Android: download certificate**. Open **Settings ▸ Security ▸
  Encryption & credentials ▸ Install a certificate ▸ CA certificate** (the path varies by
  maker; search Settings for "CA certificate"), confirm, and pick `houston-ca.crt`.
- **iPhone or iPad:** tap **iPhone or iPad: download profile** and allow the download. Open
  **Settings ▸ Profile Downloaded ▸ Install**. Then open **Settings ▸ General ▸ About ▸
  Certificate Trust Settings** and turn on full trust for the Houston local CA.

The same downloads are in the phone's **Computer** tab.

**Settings ▸ Phone & remote access ▸ Route and address ▸ Certificate ▸ Regenerate…** replaces the authority: every
device must trust the new one, and the old one stops working. To remove a trusted authority
from a device:

- **Android:** **Settings ▸ Security ▸ Encryption & credentials ▸ User credentials** (or
  **Trusted credentials ▸ User**), select the Houston local CA and remove it.
- **iPhone or iPad:** **Settings ▸ General ▸ VPN & Device Management**, select the Houston
  profile and choose **Remove Profile**.

## Pair a device

1. In **Settings ▸ Phone & remote access**, choose **Show pairing code**. Houston shows a
   QR code and a link that work once and expire after 10 minutes.
2. Scan the code with the phone's camera, or open the link on the other computer.
3. Check the address and connection shown, confirm the suggested device name or enter
   another, then choose **Connect**.
   The device is listed under **Paired devices**. **Active now** means the daemon last saw
   it less than two minutes ago; otherwise Houston shows **Last seen** with its age. This
   is recent activity, rather than a live connection indicator.
4. Follow the browser-specific installation steps if you want a home-screen shortcut,
   then choose **Open Houston**. Until Houston is installed, the steps are also in **Computer**.

**Hide code** removes the inline code from this screen; it does not turn off the listener
or invalidate a code that has already been copied. A new device or expiry removes it
automatically. **Phone notifications** and **Route and address** start collapsed.

On a phone, use the browser's **Add to Home Screen** to open Houston like an app. Each
browser keeps its own pairing; a device that lost its pairing (for example, after clearing
site data) asks to be paired again. An expired or used code explains how to get a new one.

## Answer an agent

The phone has four tabs:

- **Inbox** shows one request at a time. Swipe or use the arrows to move between requests.
  When nothing needs you, it shows working panes and recent replies.
- **Panes** groups tiles by the grids of the desktop application, in each workspace, with
  waiting panes first, followed by working and idle panes. Each tile shows the agent's
  provider and its latest step or reply. Tap a grid's name to collapse it; panes that are in
  no grid are listed under **Not in a grid**. Workspace chips show counts and an amber dot
  when a pane there needs you. The workspace choice and collapsed grids are remembered on
  this device. Grids appear once the desktop application has connected to the daemon.
- **Activity** shows recent finishes, requests and answers across panes. Tap an entry to
  open its conversation near that event. Older entries may have left the conversation's
  bounded history. Computers without activity support show an availability message.
- **Computer** shows the host, connection route and device name. Vibration, quick replies
  and screen text size are device-local preferences, as are collapsed grids; notifications and remote access
  settings are configured on the computer.

The page title counts waiting panes. Android can vibrate for a new request while Houston
is open. When the connection drops, the last state is dimmed and answers are disabled. Requests time out after 15 seconds so a stalled
request cannot keep answers blocked indefinitely. An input timeout does not confirm
whether the agent received it; check the pane before sending the same answer again.
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
  **Send answer**. Choose **Something else…** to type your own answer in the message box.
  Questions whose options carry previews offer no **Something else…**; type that answer in
  the terminal.

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
remain in the log with a **failed** label and count toward the turn summary;
listed edit paths include attempted edits even when the tool failed. When the computer
reports a turn end, a log with steps folds into a summary with its duration and changed
files. Tap the summary to reopen it. A stopped or failed turn ends with a timestamped
divider. Older computers show the tool steps without a duration or
changed-file card.
Child panes appear together
when the computer reports their relationship, and a child that needs you has an **Open**
band. Quick replies appear while the agent is idle after a reply and fill the message box
without sending. Edit them with the pencil at the end of the row or in **Computer ▸ Quick
replies**; they are kept on this device, up to 12. On a phone, swipe from the left edge
of a pane to go back.

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

## Dictate instead of typing

A paired device can record what you say and have Houston turn it into text for the message
box. Houston transcribes with the engine chosen in **Settings ▸ Dictation** (see
[Dictation](voice.md)), using its language, vocabulary and English output settings, and
returns the text to the device; nothing reaches the pane until you send it.

1. In **Settings ▸ Phone & remote access ▸ Dictation**, turn on **Allow dictation from paired
   devices**. It is off by default and does not depend on desktop dictation being on: the
   computer's own microphone is never opened for it. With the local engine, download its
   model in Settings ▸ Dictation first; with Groq, store the API key there.
2. In a pane, tap the microphone next to the message box and speak. Tap it again to stop,
   then edit the text and send it, or tap **Insert and send** to send it as soon as it is
   transcribed. **Cancel** discards the recording or pending transcript. Leaving the pane,
   signing out, or hiding the page discards pending dictation too. A recording stops by
   itself at 2 minutes.

The microphone button needs a trusted HTTPS address: the Tailscale route, or a device that
trusts this computer's certificate (see [The certificate](#the-certificate)). Otherwise the
browser may offer no microphone, and the page hides the button and says why. Your phone
keyboard's own microphone works in the message box either way, with the keyboard maker's
speech recognition instead of Houston's.

Houston transcribes one recording from a device at a time and refuses a new one while
another, or a desktop dictation, is being transcribed. A refusal names the reason: dictation
turned off, no model, no Groq key, the local engine on Windows (use Groq there), or a
recording over the limit.

### What is transmitted

- **Local engine:** the recording travels from the device to this computer and stays on
  your devices. Houston keeps it in memory only while it transcribes and then discards it;
  nothing is written to disk or logged.
- **Groq:** each recording is also sent to Groq's API for transcription, as desktop
  dictation with Groq does.
- **Keyboard microphone:** the phone's keyboard follows its maker's rules (Apple or
  Google); Houston only receives the typed text.

## Notifications with ntfy

1. Install the ntfy app on your phone and subscribe to a topic with a long, unguessable
   name. Anyone who knows the topic name can read its messages.
2. Paste the topic URL, such as `https://ntfy.sh/<topic>`, in
   **Settings ▸ Phone & remote access ▸ Phone notifications ▸ ntfy topic ▸ Set up…** and choose **Save**.
   The URL is kept in the OS keychain; the settings show only the server. **Change…** replaces
   it and **Remove** turns notifications off.
3. Adjust **Delay** (30 seconds by default, up to 600). A pane must keep waiting for that
   long before the notification goes out; if you answer on the desktop sooner, nothing is
   sent. Each time a pane starts waiting, at most one notification is sent. Closing
   the pane cancels its pending notification. The current notification settings and
   topic apply when the delay ends; turning off finished-turn notifications also
   cancels finished-turn notifications still waiting to be sent.

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

**Computer ▸ Disconnect this phone** forgets this browser's token and clears its displayed
conversations. It does not revoke the token on the computer: use **Settings ▸ Phone & remote
access ▸ Paired devices ▸ Revoke…** there to revoke access. Pair again to reconnect this browser.

Choose **Revoke…** next to a device (and confirm) to end its access immediately, including a
page it has open. A connected phone receives an explicit reason when its device is revoked
or remote access is disabled. Turning off **Allow remote access** stops the listener, closes open pages'
live updates, clears the conversations and stops notifications; paired devices stay listed
and work again when you turn it back on. To stop notifications only, open the **ntfy topic** dialog and choose **Remove**.

## Platforms

Remote access works the same on Linux and Windows. On Windows, Houston has no terminal
emulator in the daemon, so a device sees the pane's recent raw output instead of its
rendered screen, and multi-line answers are refused.
