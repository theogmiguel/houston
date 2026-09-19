# Appearance and terminal settings

Two settings sections cover how Houston looks: **Settings ▸ Appearance** for the app
chrome and window, and **Settings ▸ Terminal** for how panes render and behave.

## Settings ▸ Appearance

**Chrome theme** — pick between two overall themes, Graphite (the default) and Paper.

**Window background** — Solid (default) or Custom. Custom takes an image, dithers it the
way an old display would, and paints it behind the rail, the titlebar, the gutters and
your panes alike, with your panes' own backgrounds turned translucent so the picture
shows through your terminal text. A browser pane stays opaque — a web page isn't
Houston's to see through. Choose from a few bundled images or your own; switching back
and forth between them does not delete your own image. Custom has its own dials:

- **Pixel size** — how coarse the dithered pixels are.
- **Colour** — a toggle between the image's original colours and monochrome.
- **Brightness** — a ceiling on how bright the image may get.
- **Chrome** — how heavy a coat sits over the rail/titlebar/gutters.
- **Panes** — how heavy a coat sits over your terminal panes.
- **Fade the bottom edge** — fades the image into the theme toward the bottom of the
  window.
- **Reset window background** — restores all of the above to their defaults.

If your system has reduce-transparency or increase-contrast switched on, Custom is
disabled and Solid is shown instead for as long as that system setting stays on — your
own Custom choice is not lost, and Custom comes back on its own once you turn the system
setting back off.

**Terminal palette** — pick a color palette for terminal panes, or leave it on Auto to
follow the chrome theme.

**Sidebar** — toggle whether Skills, Routines, and Connections show as rows at the top of
the sidebar.

**App zoom** — scales the whole app: 90%, 100%, 110%, or 125%. Ctrl+/Ctrl− do the same
thing from the keyboard.

## Settings ▸ Terminal

**Type**

| Setting | What it controls | Default |
|---|---|---|
| Font size | Terminal text size | 14 (range 8–24) |
| Font family | Terminal font | — |
| Line height | Line spacing as a multiplier of font size; below 1.0 clips descenders | 1.35 (range 1.0–2.0) |

**Behaviour**

| Setting | What it controls | Default |
|---|---|---|
| Cursor blink | Whether the terminal cursor blinks | on |
| Scrollback | Lines kept per pane for newly opened panes; a reconnect only recovers what the daemon itself kept | 10,000 (range 1,000–30,000) |
| Shell integration | Terminals report prompts, commands and working directory back to Houston — powers history and handoff | on |
| Shift+Enter inserts a newline | Write multi-line prompts without sending | — |
| Clipboard access | Lets terminal apps set the system clipboard (OSC 52) | on |
| Copy on select | Selecting terminal text copies it immediately (TUIs still need Shift-drag to select) | off |
| Copy the text, not the box | Strips TUI box-drawing borders when copying | on |
| Panes per stack | How many tabs one grid cell may hold; lowering it closes nothing already open | 4 (range 2–8) |
| Idle quiet window | How long a session must be silent before Houston calls it idle | 400ms (range 100–30,000ms) |
