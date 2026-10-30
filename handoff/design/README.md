# Houston v2 design boards

The approved design for the v2 renderer. Each board is a self-contained HTML file whose
markup and `<style>` hold the exact values (sizes, spacing, colors, type).

- `boards/*.dc.html` - the boards. `{{theme}}` is `graphite` (dark) or `paper` (light). Boards
  with other `{{...}}` placeholders (`GridFlow`, the `Grid*` frames) are templates and only render
  fully in the design canvas; read their markup and CSS instead.
- `shell.css`, `pages.css` - the shared shell and page CSS the boards are built from.
- `boards/canvas.json` - which page each board sits on.
- `read-board.py` - prints a board with one CSS declaration and one tag per line. Several boards
  have lines of tens of KB that stall line-oriented tools; read them through this script:
  `python3 handoff/design/read-board.py handoff/design/boards/ScreenThread.dc.html --css | sed -n 1,120p`.

Render a board for a visual check (headless Chrome, either theme):

```
sed 's/{{theme}}/graphite/g' handoff/design/boards/ScreenThread.dc.html > .agent-tmp/board.html
google-chrome --headless=new --hide-scrollbars --window-size=1920,1400 \
  --screenshot=.agent-tmp/board.png "file://$PWD/.agent-tmp/board.html"
```

## Board to renderer area

| Area | Boards |
|---|---|
| Tokens, type scale, sizes | `Color`, `TypeLayout`, `Primitives` |
| Window top bar and controls | every screen's `header.titlebar` + `.wc` (no native title bar) |
| Main sidebar | **`SidebarFinal`** (approved; overrides `Sidebar` and the sidebar column of every screen board) |
| Thread view, timeline, composer | `ScreenThread`, `Timeline`, `Behaviours`, `Interactions` |
| Right panel (Changes, Files, Preview) | `Panels`, `ScreenFiles`, `ScreenPreview` |
| Grid | `GridFlow`, `Grid1`..`Grid6`, `GridSystem` |
| Settings | `S_*` (20 pages, one per upstream settings route) |
| States | `ScreenWelcome`, `ScreenOffline`, `ErrorStates`, `ScreenUpdate`, `UpdateFlow`, `PullRequests`, `Usage`, `ScreenPalette` |
| Thread features | `ThreadHtml`, `ThreadSubagents`, `ThreadModels`, `ThreadAnnotations`, `ThreadStash` |
| Later slices | `QuickComposer`, `SideQuestion`, `Providers` (Additions page) |

## Rules

1. **Structure and look follow the board; behaviour follows the ported code.** Layout, which
   surfaces exist (top bar contents, docked panels, pane head, composer controls) and where each
   control lives come from the board. A board replaces upstream's component structure; it is not
   a reskin of it. Upstream behaviour the board does not show keeps working and moves to where
   the board's structure would put it (a menu, the right panel, settings), never back into an
   upstream-only popover or card. Never drop a setting, handler or test; never invent behaviour
   a board shows but the code lacks: report it instead. Copy text from the code when it differs.
2. The accent is used only where a board uses it (selection, running state, primary actions such
   as Allow). Send buttons, focus rings of fields and banners stay neutral unless their board
   colours them.
3. Style through `apps/web/src/index.css` tokens and the primitives in
   `apps/web/src/components/ui/`. Add a primitive variant rather than one-off classes.
4. Both themes. Controls 28px tall, top bar 40px, pane head 30px, settings column 720px.
5. **The product is Houston.** No user-visible text says "T3 Code", "T3" or "t3code". Leave
   package names (`@t3tools/*`), code identifiers and storage keys alone.
6. A screen is done only with captures of the real app beside the board, in both themes and in
   every state the board shows (empty, loading, error, long text, narrow width). Typecheck and
   tests passing is not enough.
7. Keep upstream's tests green; update a test only when it asserts a visual detail you changed.

## Decisions that override the boards

- **Icons come from lucide**, as in the ported code (`TerminalIcon`, `PanelRightIcon`, `MoonIcon`,
  ...). A board sets where an icon sits and its size (15px in a 28px control), not its drawing.
  An icon with no lucide match is reported, not hand-drawn.
- **Theme control** uses the moon icon (`MoonIcon`, with `SunIcon`/`MonitorIcon` per mode), not
  the half-filled circle the boards draw.
- **Top bar controls**, left to right: Terminal (Ctrl J), Grid layout (grid icon with a chevron;
  the menu holds Auto arrange and the GridSystem presets), Right panel (Ctrl Alt B), then the
  window controls. There is no "Add thread to grid" button in the top bar.
- **New thread** opens a draft pane in the current grid, split beside the focused pane, with the
  composer focused. The composer's top row holds project, Local checkout / New worktree /
  Existing worktree, base branch and machine, defaulting to the focused pane's. Nothing is
  created until Enter; Esc or the pane's close discards the draft. An empty grid shows the same
  composer centred at 760px with no pane head. Entry points: `T` when focus is outside a text
  field, the `+` on a grid row in the sidebar (tooltip "New thread · T"), and the existing
  `chat.new` / `chat.newLocal` keybindings.
