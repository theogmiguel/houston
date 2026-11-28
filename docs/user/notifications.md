# Notifications

**Settings ▸ General ▸ Notifications** controls three kinds of notice:

- **Thread notifications** — system notifications and sound when a thread finishes, fails,
  or needs input or approval. **Notification style** chooses notifications, sound, or both.
  The setting applies to this device while Houston is open.
- **In-app notifications** — a toast while the app has focus when another thread finishes,
  fails or needs you.
- **Notify me when a thread waits for me** — one system notice when a root thread gets a
  pending question or approval, and one reminder if it is still pending after 30 minutes. It
  works whatever the other notification settings are; it plays a sound only when the
  notification style includes sound. A sub-agent's question notifies the same way only while
  its coordinator is not running. A request the existing thread or in-app notice already
  announced is not announced again. It applies to this device and is off by default.

All three are off by default. The waiting notice turns on only from its setting; there is no
offer on a question card.

A system notification shows the thread and its project. Clicking it raises Houston, opens
the thread and focuses its tab. A newer notification for the same thread replaces
the previous one where the desktop supports it. If the desktop refuses notifications,
Settings names the reason and sound-only stays available.

In-app notices for a finished thread dismiss after a few seconds; a needs-you notice stays
until opened or dismissed. A thread that is already on screen only changes its status
indicator.

Child threads report to their parent; the parent receives the pending approval or question.
The sidebar status marks are described in [Agent status](agent-status.md).

**When notices cannot be sent.** Notices come from the Houston window that is connected to
the server. Closing the window to the tray keeps them working, but quitting the host stops
them, and with no window connected to the server no notice can be shown. A browser tab
without permission to show system notifications falls back to sound when the notification
style includes it. In-app notices need the window to be open and focused.
