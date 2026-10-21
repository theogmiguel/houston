# Notifications

Open Settings ▸ Notifications to choose how Houston reports when an agent pane finishes a turn or needs your input. Both options are off by default.

Desktop notifications appear only while the Houston window is unfocused. Choose Off, Notifications only, Sound only, or Notifications with sound. A desktop notification shows the pane, agent and workspace; clicking it focuses Houston and opens that pane. Sound only plays locally and does not send a desktop notification. When several panes finish in the same moment, the finished sound plays once for the burst; a needs-input sound is never silenced by it.

On Linux, the desktop notification service controls whether these notices are allowed. If delivery is refused, allow notifications for Houston in the desktop's notification settings. Native desktop notifications are not available on Windows or macOS yet.

In-app notifications appear while Houston is focused when the pane is in another grid or workspace. A pane already on screen only changes its status indicator. Finished notices dismiss after a few seconds; needs-input notices stay until opened or dismissed. After a finished notice dismisses, the pane's rail card keeps the unread mark — the grid name in bold with a dot — until you focus that pane.

Child panes report to the agent that started them, not to you. The taskbar icon counts the panes waiting on you.

To visit each request in turn, press the prefix key and then `!` (**Next request**). It goes to the oldest pane in Needs input, child escalated to you or message addressed to you, in any workspace; `Backspace` after the prefix returns to where you were. See [Keybindings](keybindings.md).
