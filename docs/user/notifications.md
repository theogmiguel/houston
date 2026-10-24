# Notifications

Open Settings ▸ Notifications to choose how Houston reports when an agent pane finishes a turn or needs your input. Both options are off by default.

Desktop notifications appear only while the Houston window is unfocused. Choose Off, Notifications only, Sound only, or Notifications with sound. A desktop notification shows the pane, agent and workspace; clicking it shows and focuses the Houston window, including one hidden to the tray, and opens that pane. Each pane keeps one desktop notification: a newer one from the same pane replaces it. Sound only plays locally and does not send a desktop notification. When several panes finish in the same moment, the finished sound plays once for the burst; a needs-input sound is never silenced by it. If the connection to the daemon drops, a finish or an input request that happened while Houston was disconnected is reported once when the connection returns; a request already answered, or a pane that was already waiting for input before the drop, is not reported again.

On Linux, the desktop notification service controls whether these notices are allowed. If delivery is refused, allow notifications for Houston in the desktop's notification settings. A notification clicked more than an hour after it appeared no longer opens its pane.

On Windows, desktop notifications require Houston installed with its Windows installer, which registers the Start menu shortcut that Windows uses to identify the app. If notices are missing, allow Houston in Windows Settings ▸ System ▸ Notifications. A notification kept in the notification center opens its pane when clicked for as long as Houston runs, for the latest notification of up to 256 panes. When Windows reports notifications as off for Houston, or no installed shortcut exists, Settings ▸ Notifications shows the reason and the notification options stay unavailable. Native desktop notifications are not available on macOS yet.

In-app notifications appear while Houston is focused when the pane is in another grid or workspace. A pane already on screen only changes its status indicator. Finished notices dismiss after a few seconds; needs-input notices stay until opened or dismissed. After a finished notice dismisses, the pane's rail card keeps the unread mark — the grid name in bold with a dot — until you focus that pane.

Child panes report to the agent that started them, not to you. The taskbar icon counts the panes waiting on you.

To visit each request in turn, press the prefix key and then `!` (**Next request**). It goes to the oldest pane in Needs input, child escalated to you or message addressed to you, in any workspace; `Backspace` after the prefix returns to where you were. See [Keybindings](keybindings.md).
