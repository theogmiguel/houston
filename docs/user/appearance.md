# Appearance, typography and chat

**Settings ▸ Appearance** controls how Houston looks. **Settings ▸ Chat** and **Settings ▸
Diffs & pull requests** control the composer and diffs.

## Themes

**Colors & themes** offers light, dark and system mode, a set of built-in themes, and custom
themes. A custom theme can be created from scratch, duplicated from an existing one, edited,
exported or imported. VS Code theme files can be imported.

The same page sets **Contrast**, **Glass opacity**, **Animations**, **Environment
identification**, **Chat width**, **Effort display**, **Render math** and whether branch and
worktree controls stay visible below the composer in active threads.

**Environment identification** shows a Dev or Nightly pill beside the name in the sidebar
header, on by default. Release builds show no pill. **Chat width** sets the width of the message
timeline: Comfortable, Wide or Full. Grid cells keep their own widths.

**Animations** is on by default. Turning it off stops menu, dialog, list and grid motion
across the application, as the system's reduce-motion setting also does. Panels and drawers
open and close without animation either way.

## Typography

**Settings ▸ Appearance ▸ Typography** sets the interface font and size, and the code font
used by code blocks, diffs and file previews. **Separate fonts** adds independent prompt and
terminal fonts. **Word wrap** wraps long lines in code blocks, diffs and file previews. It is
off by default, so long lines scroll sideways; diffs and file previews also have their own wrap
toggle.
Each font picker has a reset button. A font must be installed on the machine; Houston does
not download fonts.

## Chat

**Settings ▸ Chat** controls the composer:

- **Rich text composer** shows formatted Markdown as you type in the thread composer.
- **Send shortcut** chooses whether Enter sends, `Ctrl+Enter` inserts a line break, or
  `Ctrl+Enter` always sends.
- **Show skills in slash menu** adds skills to the `/` menu; `$` always lists them.
- **Follow-up behavior** sets what a message sent while the agent works does: **Queue**
  sends it when the turn ends, and **Steer** redirects the running turn, or queues the
  message when the provider cannot steer.

The composer's send menu also offers **Queue message**, **Steer message** and **Interrupt
and send** while a turn runs. See [Threads and grids](threads-and-grids.md#the-composer).

## Diffs

**Settings ▸ Diffs & pull requests** sets the diff layout, whether whitespace-only changes
are hidden by default, whether files start expanded or collapsed, and the diff colors.
**Open pull requests and changes panels proactively** opens the matching panel when an agent
finishes, except in grid cells and narrow windows.
