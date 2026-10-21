# Keybindings

Houston's thesis is that a pane is a real terminal: every keystroke you send into a
focused pane reaches the agent running there. Houston's own shortcuts exist alongside
that, and **Settings ▸ Shortcuts** is where you see and rebind them.

## Where the keymap lives

Defaults are built into Houston; there is no keymap file on disk for you to edit
directly. What you change in Settings ▸ Shortcuts is a small set of overrides — just the
chord for each rebound command, plus whether shortcuts are enabled at all — stored by the
daemon, not a text file you hand-edit.

## Pass through to terminal

Settings ▸ Shortcuts has a **Pass through to terminal** toggle (off by default). With it
off, a focused pane still receives Houston's remappable chords as Houston shortcuts
first. Turn it on and a focused pane gets those same chords sent to the process running
in it instead of acting on them in Houston. The prefix key (below) is the exception: it
stays with Houston either way, so the keyboard always has a way out of a terminal.

This does not cover the terminal-native clipboard and find actions. `Ctrl+C` copies when
there is a selection and otherwise reaches the PTY as an interrupt. `Ctrl+Shift+C` always
copies; `Ctrl+V`, `Ctrl+Shift+V` and `Shift+Insert` paste; and `Ctrl+F` opens terminal
search. These actions remain fixed regardless of the pass-through setting.

There's a related master switch, **Enable shortcuts**, also in this section: turning it
off stops Houston from acting on any of its own chords at all (your overrides are kept,
just not dispatched).

## The prefix key

With a terminal focused, every key reaches the agent, so the single-key shortcuts below
(`t`, `]`, `1`–`9`, …) do not fire. The **prefix key**, `Ctrl+Space` by default, is the
one chord Houston keeps for itself in that state: press it, then press a shortcut key,
and the shortcut runs even though the terminal has the keyboard. The layer is one-shot:
after the next key it is down again. `Esc`, or any key that is not a shortcut, cancels
it without reaching the terminal. Pressing the prefix twice sends the chord itself to
the terminal. If no key follows for a moment, a hint lists what the layer accepts and
stays until you press a key; a prefix left alone for several seconds is forgotten.

The prefix can be rebound in Settings ▸ Shortcuts but not unbound; only **Enable
shortcuts** turns it off, together with every other Houston chord. `Esc`, `Ctrl+C`,
`Shift+Tab`, `Ctrl+B`, `Ctrl+K`, `Ctrl+L` and `Ctrl+R` keep reaching the agent as before.
Two shortcuts exist only after the prefix, because their keys mean something on their
own: `Tab` (last workspace) and `Space` (command palette). The workspace and grid moves
are also in the command palette, as Previous / Next / Last workspace and Previous / Next
grid.

**Next request** (`!` after the prefix) goes to the oldest request waiting on you in any
workspace: a pane in Needs input, a child escalated to you, or a message under **Addressed
to you**. It switches workspace and grid as needed and opens an escalated child in its
orchestrator's roster, as **Answer** does. Each further press moves to the next request,
oldest first, and wraps after the newest; answered requests drop out. With nothing
waiting, Houston shows "Nothing is waiting on you". **Back** (`Backspace` after the
prefix) returns to the pane and grid you were on before the first jump. The command
palette lists both, with the number of waiting requests in **Next request (N)**.

The prefix works while a terminal pane, or no pane, has focus. It does not work while a
browser pane has focus, because that pane is a native webview whose keys never reach
Houston's window, nor while an editor pane has focus, where the keys go to the editor;
click outside the pane first. While a dictation is running in the focused pane, the
prefix does nothing and `Ctrl+Space` reaches the terminal, so it cannot cut the
dictation short.

## Not every shortcut is rebindable

The Shortcuts screen also lists a handful of terminal-native shortcuts marked "Not
remappable": copy (`Ctrl+C`), force-copy (`Ctrl+Shift+C`), paste (`Ctrl+V` /
`Ctrl+Shift+V` / `Shift+Insert`) and find (`Ctrl+F`). They stay fixed so clipboard,
selection and terminal-search behavior is consistent across panes.

## Default shortcuts

All of the following are rebindable from Settings ▸ Shortcuts unless noted.

| Shortcut | Default chord |
|---|---|
| Close dialogs / collapse | Esc |
| Zoom in | Ctrl+ / Ctrl+= |
| Zoom out | Ctrl− |
| Zoom reset | Ctrl+0 |
| Terminal font size up | Ctrl+Alt+ |
| Terminal font size down | Ctrl+Alt− |
| Terminal font size reset | Ctrl+Alt+0 |
| Toggle sidebar | Ctrl+B |
| Open the Add Pane menu | Ctrl+Shift+B |
| Close workspace | Ctrl+Shift+W |
| Rename workspace | F2 |
| Prefix: the next key is a Houston shortcut inside a focused terminal | Ctrl+Space |
| Previous / next workspace | p / n |
| Back to the last workspace (after the prefix) | Tab |
| Previous / next grid in this workspace | , / . |
| Open the command palette (after the prefix) | Space |
| New browser tab / Open Files / Changes / Pull request / Linked pull requests (after the prefix) | B / F / D / P / L |
| Open the Pull Requests screen (after the prefix) | R |
| Go to the next request waiting on you (after the prefix) | ! |
| Back to the pane you were on before Next request (after the prefix) | Backspace |
| Move the selected rail card up / down (Manual sort) | Mod+Shift+↑ / Mod+Shift+↓ |
| Open Files Quick Open outside a terminal | Mod+P |
| Search file contents in this workspace outside a terminal | Mod+Shift+F |
| Select pane (visual order) | 1–9 |
| New terminal in this workspace | t |
| Open a file in the editor | o |
| Expand / collapse pane | z |
| Split right | d |
| Split up | w |
| Split left | a |
| Split down | s |
| Tidy panes into a balanced grid | y |
| Tidy panes into one row | h |
| Tidy panes into one column | v |
| Reset every split to an even share | = |
| Focus previous pane | [ |
| Focus next pane | ] |
| Swap pane with previous | { |
| Swap pane with next | } |
| Toggle source control | g |
| Show this shortcuts sheet | ? |
| Focus the browser address bar | Ctrl+L |
| Open settings | Ctrl+, |
| Open the command palette | Ctrl+K |
| Split editor pane down (not remappable) | Ctrl+Shift+D |
| Find in the focused diff: Changes, pull request files | Ctrl+F |
| Hold to dictate into this terminal (Settings ▸ Dictation) | Ctrl+Shift+Space |
| Copy selection — no selection interrupts the agent (not remappable) | Ctrl+C |
| Copy selection, force (not remappable) | Ctrl+Shift+C |
| Paste, accepts screenshots (not remappable) | Ctrl+V / Ctrl+Shift+V / Shift+Insert |
| Find in the terminal (not remappable) | Ctrl+F |

Three chords Houston binds globally — `Ctrl+B`, `Ctrl+K`, `Ctrl+L` — are also readline
reflexes inside a shell or many CLIs. Inside a focused terminal, the terminal wins: those
three keys reach the agent even though the same chords are bound at the app level
elsewhere.

Workspace actions can optionally bind a shortcut when you add or edit them. The shortcut
runs the saved command in a new shell pane in the current workspace. A chord already owned
by Houston or another workspace action is refused with its owner named.

## Reviewing Changes

In maximized Changes, `/` focuses the filename filter and `J`/`K` move through matching
files. These keys do not navigate while you type into a field or use a menu. **Esc**
restores the panel's previous width. In branch search, **Enter** creates a new branch
from the default base; **Ctrl+Enter** creates its worktree in a new pane. These local
review and search shortcuts are separate from the terminal prefix key.

`Ctrl+F` in Changes or a pull request's **Files** opens find in the diff (see
[Changes](changes.md#reviewing-a-diff)). It answers only while focus is inside the diff, so
it never takes `Ctrl+F` from a focused terminal, and it can be rebound on its own.
