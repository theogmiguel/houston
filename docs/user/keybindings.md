# Keybindings

Open **Settings ▸ Keybindings** to see every command with its current chord, its condition
and whether it is a default, a custom binding or inherited from a project. The page also
sets the desktop's **Quick composer** global shortcut.

Add a binding, change one, reset it to its default, or remove it. A command can have more
than one binding, and a binding can carry a condition such as `terminalFocus` or
`gridRoute`. The file that stores the bindings can be opened in your editor from this page.
Keybindings are stored by the server, so they apply to the environment you are editing.

`Mod` is `Ctrl` on Linux and Windows and `Cmd` on macOS.

## Common defaults

| Shortcut                        | Command                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `Ctrl+K`                        | Command palette                                                         |
| `Ctrl+N`                        | New thread                                                              |
| `Ctrl+Shift+N`                  | New local thread                                                        |
| `Ctrl+Alt+N`                    | New thread without a project                                            |
| `Ctrl+B`                        | Toggle sidebar                                                          |
| `Ctrl+J`                        | Toggle terminal drawer                                                  |
| `Ctrl+Alt+B`                    | Toggle right panel                                                      |
| `Ctrl+Shift+B`                  | Toggle thread details                                                   |
| `Ctrl+T`                        | New right-panel surface                                                 |
| `Ctrl+W`                        | Close terminal or right-panel tab                                       |
| `Ctrl+D`                        | Toggle diff (outside a terminal)                                        |
| `Ctrl+P`                        | File picker                                                             |
| `Ctrl+Alt+V`                    | Dictate in the composer                                                 |
| `Ctrl+Shift+F`                  | Project search                                                          |
| `Ctrl+F`                        | Find in thread                                                          |
| `Ctrl+U`                        | Usage                                                                   |
| `Ctrl+Shift+T`                  | Reopen closed tab or grid cell                                          |
| `Ctrl+Shift+S`                  | Close thread                                                            |
| `Ctrl+Shift+P`                  | Pin thread                                                              |
| `Ctrl+.` / `Ctrl+Shift+.`       | Next / previous thread needing attention                                |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Previous / next thread                                                  |
| `Ctrl+1` … `Ctrl+9`             | Jump to a thread                                                        |
| `Ctrl+Shift+Enter`              | Steer the first queued message; in a grid, maximize or restore the cell |
| `Ctrl+Alt+Enter`                | Send in the background                                                  |
| `Esc`                           | Stop the current turn                                                   |
| `Ctrl+S`                        | Stash the composer prompt                                               |
| `Ctrl+Shift+M`                  | Model picker                                                            |
| `Ctrl+Shift+E`                  | Reasoning effort                                                        |
| `Ctrl+Shift+A`                  | Interaction mode                                                        |
| `Ctrl+Shift+X`                  | Workspace                                                               |
| `Ctrl+Shift+G`                  | Branch                                                                  |
| `Ctrl+Shift+L`                  | Previous worktree                                                       |
| `Ctrl+Shift+C`                  | Copy pull request link or thread reference                              |
| `Ctrl+Shift+K`                  | Copy pull request number                                                |
| `Ctrl+Q`                        | Quit, following the quit confirmation setting                           |

Grid commands are rebindable too: **Balanced grid**, **One row**, **One column** and
**Equalize splits** are `Y`, `H`, `V` and `=` when no terminal or editable field has focus.
The focused grid cell receives the thread shortcuts; other cells bind none.

## Terminal

The focused terminal receives its keys directly. Houston keeps these terminal-native
actions fixed:

- `Ctrl+C` copies a selection; with no selection it interrupts the running program.
- `Ctrl+Shift+C` copies a selection.
- `Ctrl+Shift+V` and `Shift+Insert` paste; middle-click pastes on Linux and BSD.
- History navigation uses `Shift+PageUp`, `Shift+PageDown`, `Ctrl+Shift+Home` and
  `Ctrl+Shift+End` when the program does not use the alternate screen.

A terminal command whose condition requires a non-terminal focus does not fire while the
terminal is focused; click outside the terminal or switch to another surface first.

## Diffs and lists

In a diff, `Ctrl+F` opens find, `Enter` and `Shift+Enter` move between matches, and `Aa`
toggles case matching. In Changes, `/` focuses the file filter and `J`/`K` move between
matches.

In the sidebar, `F2` renames the focused thread or grid. `Up`, `Down`, `Home` and `End`
move between rows, `Left` and `Right` collapse or expand a section or move to its parent or first child, and `Enter` or `Space`
opens the focused row. While the search field has focus, `Down` and `Up` move the highlighted
result and `Enter` opens it. Holding the jump modifier labels the first nine rows with their
`Ctrl+1` … `Ctrl+9` shortcut. Drag to reorder pinned and active threads; the rail follows the
same order.

## Usage

On the Usage page, `C`, `T` and `L` switch between Cost, Tokens and Limits, and
`Ctrl+Shift+1` to `Ctrl+Shift+4` select 24 hours, 7 days, 30 days and 90 days.
