# Appearance, typography and chat

**Settings ▸ Appearance** controls how Houston looks. **Settings ▸ Chat** and **Settings ▸
Diffs & pull requests** control the composer and diffs.

## Themes

**Colors & themes** offers light, dark and system mode, a set of built-in themes, and custom
themes. A custom theme can be created from scratch, duplicated from an existing one, edited,
exported or imported. VS Code theme files can be imported.

### Custom CSS

For a change that colors cannot make, open **Custom CSS** in the theme editor. The CSS is saved
with the theme, applies after Houston's own styles on web and desktop, previews as you type, and
is included when you export or import the theme. It holds up to 20,000 characters; the editor
shows the count when you go over, and the theme is not saved until it fits. Use `.dark` or
`:root:not(.dark)` to target one appearance.

Custom CSS cannot load files, so a theme from another person or an agent cannot send what is on
your screen to another site. `@import`, `image-set()` and `url()` are ignored, except `url()`
with a `data:` address or an `#id`. A declaration that contains a backslash is ignored too, and
so is an at-rule Houston cannot check. Only the affected declaration or rule is dropped; the
rest of the theme still applies.

Class names in the app change between releases. For rules that keep working, target `data-slot`
and other `data-` attributes, such as `[data-chat-header]` or `[data-slot="button"]`. Panes and
tabs have `[data-layout-tab-bar]`, `[data-layout-pane-tab]` (the selected tab has
`aria-selected="true"`) and `[data-layout-pane-content]`. Some app
rules are more specific than yours and need `!important`. CSS cannot reach terminal text, the
file tree or diff internals; use theme colors for those.

If a rule hides something you need, pick the Houston theme in **Colors & themes**, or run
`houston theme set houston` on the machine that runs the server. `houston` is the default look
with no theme; a built-in theme id such as `grove` works too.

### Ask an agent

An agent running in a thread on this machine can restyle Houston for you. Ask it to change the
look, for example "make the chat header taller", "give Houston a solarized theme" or "switch me to
dark mode". It publishes a theme with colors and CSS on the server and switches the web and
desktop clients of that server to it, or switches them to light, dark or system mode. It can
only change the server it runs on, and only from a thread with full access or the default
access mode. The agent cannot see the result, so it works in small steps and asks how it looks.
Ask it to switch back to the default look to undo a change, or use the steps above.

The same page sets **Contrast**, **Glass opacity**, **Animations**, **Environment
identification**, **Chat width**, **Effort display**, **Render math**, **Word wrap** and whether
branch and worktree controls stay visible below the composer in active threads.

**Environment identification** shows a Dev or Nightly pill beside the name in the sidebar
header, on by default. Release builds show no pill. **Chat width** sets the width of the message
timeline: Comfortable, Wide or Full.

**Animations** is on by default. Turning it off stops menu, dialog, list and layout motion
across the application, as the system's reduce-motion setting also does. Panels and drawers
open and close without animation either way.

**Word wrap** wraps long lines in code blocks, diffs and file previews. It is off by default, so
long lines scroll sideways; diffs and file previews also have their own wrap toggle.

## Layout

The layout settings in **Settings ▸ Appearance** are saved on this device and apply to every
project. **Your layout** is the arrangement a new chat opens into: a chat with a terminal below it
by default, which you can rearrange in the editor and **Reset**. **Behavior** sets:

- **Terminal**: below the chat (default), in a new tab or in a new column.
- **Side pane**: beside the chat (default), in a new tab or at the end of the strip. This is where
  diffs, files, the browser and pull requests open.
- **Side pane opens on**: last used (default), Diff, Files, Browser or Pull request.
- **New tabs**: after the current tab (default) or at the end.
- **When it doesn't fit**: what happens when a new pane has no room. **Shrink, then scroll**
  (default) narrows columns down to 420px and then scrolls, **Always shrink** keeps every column in
  view, and **Always scroll** keeps column widths and scrolls. In every mode the columns together
  are at least as wide as the window.

On macOS, **Three-finger swipe** moves one column, or one workspace up or down, per flick.

## Typography

**Settings ▸ Appearance ▸ Typography** sets the interface font and size, and the code font
used by code blocks, diffs and file previews. **Separate fonts** adds independent prompt and
terminal fonts. Each font picker has a reset button. A font must be installed on the machine; Houston does
not download fonts.

## Chat

**Settings ▸ Chat** controls the composer:

- **Rich text composer** shows formatted Markdown as you type in the thread composer. When
  the cursor is on styled text, its Markdown shows instead, such as `**bold**`, and the
  markers edit like any other text: delete them to remove the style, or change `**` to `*`
  for italic. The style updates when the cursor leaves. Styled text that contains or touches
  literal Markdown characters, such as a bold `path\` or `2*3`, keeps its styling without
  showing markers; use the formatting shortcuts or turn the setting off to edit those ranges.
- **Send shortcut** chooses whether Enter sends, Enter sends until the prompt has a line break and
  then `Ctrl+Enter` sends, or `Ctrl+Enter` always sends.
- **Show skills in slash menu** adds skills to the `/` menu; `$` always lists them.
- **Follow-up behavior** sets what a message sent while the agent works does: **Queue**
  sends it when the turn ends, and **Steer** redirects the running turn, or queues the
  message when the provider cannot steer.

The composer's send menu also offers **Queue message**, **Steer message** and **Interrupt
and send** while a turn runs. See [Threads and workspaces](threads-and-workspaces.md#the-composer).

## Diffs

**Settings ▸ Diffs & pull requests** sets the diff layout, whether whitespace-only changes
are hidden by default, whether files start expanded or collapsed, and the diff colors.
**Open pull requests and changes panels proactively** opens the matching panel when an agent
finishes, except in layout panes and narrow windows.
