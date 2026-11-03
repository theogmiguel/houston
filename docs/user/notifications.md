# Notifications

**Settings ▸ General ▸ Notifications** controls two kinds of notice:

- **Thread notifications** — system notifications and sound when a thread finishes, fails,
  or needs input or approval. **Notification style** chooses notifications, sound, or both.
  The setting applies to this device while Houston is open.
- **In-app notifications** — a toast while the app has focus when another thread finishes,
  fails or needs you.

Both are off by default.

A system notification shows the thread and its project. Clicking it raises Houston, opens
the thread's grid and focuses its cell. A newer notification for the same thread replaces
the previous one where the desktop supports it. If the desktop refuses notifications,
Settings names the reason and sound-only stays available.

In-app notices for a finished thread dismiss after a few seconds; a needs-you notice stays
until opened or dismissed. A thread that is already on screen only changes its status
indicator.

Child threads report to their parent; the parent receives the pending approval or question.
The sidebar and grid status marks are described in [Agent status](agent-status.md).
