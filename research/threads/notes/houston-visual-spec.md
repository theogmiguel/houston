# Houston graphite visual specification

Scope: current checkout; code inspection only. Default shell zoom = 1; graphite, non-custom background. All paths below are repository-relative. Numbered source excerpts preserve original line numbers and exact DOM/classes. CSS variables are expanded in the token ledger below; transparent colour mixes are intentionally retained rather than replaced with an opaque hex.

## 1. App shell

| Surface | Geometry and visible contents | Source |
|---|---|---|
| Root | Full viewport; CSS grid columns `240px minmax(0,1fr)`; rows `38px 1fr`; areas `"rail topbar" "rail grid"`. Rail spans both rows. Collapsed rail column = 0px. | `components/Shell/Shell.tsx:20`; `railWidth.ts:6` |
| Titlebar | 38px high, shell material = `--rail-bg #0f0f12`; grid `minmax(0,1fr) auto`, drag region, select-none. Lead flex gap 6px, left inset 10px. Brand is in the rail, not the normal titlebar. Show sidebar button only while rail is collapsed; settings breadcrumb while settings open. Right: microphone chip when applicable, Tidy panes (disabled with <2 panes), source-control toggle, native-layout window controls. | `App.tsx:3568`; `components/ui/AppTitlebar.tsx:13` |
| Window controls | Layout follows platform/windowButtonLayout; glyphs minimize/maximize-or-restore/close. Button 30px × 38px; internal disc 20px ×20px radius 6px; glyph SVG 10px. Dock padding-left 10px, margin-right -4px. Foreground = mix(text-muted 55%, text-primary) ≈ #b1b1b8. Regular hover accent 16% transparent, accent 75% + primary ink; close hover danger 20%, danger text; active 24% /30%. No traffic-light circles. | `components/WindowControls.tsx:29`; `components/ui/WindowControl.tsx:3`; `WindowControlDock.tsx:5` |
| Rail width | Default 240px; min 220px, max 500px; collapse threshold 160px; persistence `tr-rail-width`. | `railWidth.ts:3` |
| Main grid | `--content-bg #0a0a0b`; pane gutter 8px. Outer edges inset 8px; interior edges inset 4px each, producing 8px between panes. Geometry uses absolute percentage slots, not CSS grid gap. Custom backgrounds use 16px gutters. Left region corner cut radius = 10+8=18px. | `components/LayoutView.tsx:188`; `theme.css:1215,1539` |
| Terminal ground | `--tool-code-bg #000000` → pane/frame background; header separately graphite mix. | `theme.css:312,1160` |
| Inspector/right panel | Default width `max(340,min(460,round(viewportWidth*.3)))` px, then clamped against host width to preserve 360px terminal floor; 340px is fallback/minimum, NOT universal default. At viewport 1440px:432px; 1280px:384px. Persist `tr-scm-width`; flex-none, full height, rail background #0f0f12. | `scmPanel.ts:6`; `components/SidePanel.tsx:654`; `components/ui/inspector.css:1` |
| Right tab strip | Actual surfaces: Browser, Files, Diff, Pull request, Linked pull requests. Browser title or New tab; file name can replace Files; PR number can replace Pull request. Fresh inspector has no open tabs and displays launcher; `sidePanel.ts`'s scm/files fallback is legacy, not this surface's default. Strip 34px tall, gap4, inset left8/right6, 1px divider #1e1e22. Tabs h24,max-w144,padding L4/R8,gap2,radius6,12px/500. Active bg `--hover-strong #ffffff14`; hover `--hover-fill #ffffff0d`. 16px icon slot swaps glyph for close on hover. Header action buttons 24px. | `components/SidePanel.tsx:44,121`; `scmPanel.ts:133`; `components/ui/panel.css:1` |

`titlebar.ts:3` only defines drag eligibility: left button, not double click, no child matching `[-webkit-app-region:no-drag]`. `customChrome.ts:6` only turns `data-custom="on"` on when background mode is custom; default graphite has no custom attribute.

## 2. Rail: active structure and retained branches

Top-to-bottom DOM/component tree (default preferences):

```text
TagPopoverHost (context wrapper)
└─ aside RailSurface [data-material=shell, data-grid-area=rail]
   ├─ RailHead → NavigationRailHeader [h38 flex gap12 px12]
   │  ├─ img brand mark32×32 (assets/brand-mark-32.png; srcSet 64/96)
   │  ├─ span Houston [13px/600; tracking -.025em]
   │  └─ hide-sidebar Button subtle-icon [28×28; radius6]
   ├─ RailNav → div [flex-col gap2 px8 pb4]
   │  ├─ Search [h30, px8, gap8, radius6, hover-fill,12px/400; search icon + shortcut HintKey]
   │  ├─ Tasks [IconTasks; optional count]
   │  ├─ Skills [IconZap]
   │  ├─ Routines [IconClock]
   │  ├─ Harness [IconTarget; attention count]
   │  └─ Connections [IconGlobe]
   ├─ NavigationRailScroll [flex1 min-h0 overflow-y-auto overflow-x-hidden flex-col]
   │  └─ NavigationRailSection / rail-tree
   │     ├─ RailTreeGroupHeader: Workspaces (or Grids), Sidebar options/sliders,
   │     │  Add workspace/folder-plus (Local folder… / Connect via SSH…), New grid/plus
   │     └─ RailVirtualList → RailVirtualViewport
   │        ├─ optional Pinned group and its cards FIRST
   │        ├─ WorkspaceRailGroupRow: disclosure chevron, folder glyph, workspace name,
   │        │  grid count, optional pin glyph, hover New session plus
   │        └─ GridRailRowView cards (when group expanded)
   ├─ MascotMount (conditional user preferences/first-run; not a fixed row)
   └─ NavigationRailFooter [flex gap4 px8 pt4 pb6]
      ├─ Settings/gear ├─ Pull requests ├─ Usage/chart ├─ theme/moon
      └─ conditional update button at far right
```

References: `Sidebar.tsx:1461,1504,2153,2860,2983`; `railView.ts:3,7`; `components/ui/NavigationRail.tsx:18,23,37,41`; `NavigationRailFooter.tsx:3`; `components/ui/rail/RailChrome.tsx:129`.

Nav rows h28, px8, gap9, radius6, 13px weight500, tracking -.01em. Normal text-secondary #b4b4bd, icon text-faint (shell scope #52525a). Selected fill #ffffff1a, primary #f4f4f6 and accent icon #5c8fff. Footer subtle buttons 28px, transparent; hover card-hover #1c1c20.

Active workspace group row: h28, px8, gap8, radius6; 13px semibold (600), folder13, chevron12; count11/500; no colour square. Selected background selected-fill. `WS_COLORS` exists at `Sidebar.tsx:399`: `#94a3b8,#ef4444,#f97316,#f59e0b,#eab308,#84cc16,#22c55e,#10b981,#14b8a6,#06b6d4,#0ea5e9,#3b82f6,#8b5cf6,#ec4899,#f43f5e`; index modulo15. The active `WorkspaceRailGroupRow` passes colour into menus but renders a folder icon; do not invent a square. `WorkspaceTreeRow` can optionally render a 3px selection rail and colour-mix outline/fill if `selectionColor` is passed, but this active group does not pass it.

Important reachability: `Sidebar.tsx:209` ignores both `groupBy` and `renderWorkspaceContent` and always returns RailVirtualList. Thus `CollapsedGridsRow` (`:859`) and `ExpandedGridsRow` (`:1063`) are retained but their workspace-content callback is not rendered. Their DOM is documented in the source appendix: collapsed has disclosure/folder/name/pin, expanded adds hover New session and child cards; expanded sorts pinned grids first, adds Pinned heading then divider before unpinned. These are NOT the active top-level rail tree.

Active card DOM (`components/ui/rail/GridRailRowView.tsx:100`):

```text
Tooltip [block]
└─ div rail-grid-row [role=button,tabIndex=0]
   ├─ Tooltip → button grid-unread-toggle [w16; detailed h20,pt5]
   │  └─ span grid-state-dot
   ├─ div [flex min-w0 flex1 flex-col gap5]
   │  ├─ GridRailTitleRow [h20,flex gap6,13px leading20]
   │  │  ├─ truncated title (unread:600/primary)
   │  │  ├─ unread blue pip6px (if enabled)
   │  │  ├─ flexible spacer
   │  │  ├─ draft badge (border,px4,11px/line16) if PR draft
   │  │  ├─ optional tags (disabled in default property list)
   │  │  └─ hover close [absolute right4 top4,size20,radius4,small icon]
   │  ├─ GridRailCheckoutLine [h16,gap4,mono11,muted]
   │  │  ├─ branch icon12 + truncated checkout text
   │  │  └─ ml-auto flex gap6: PR icon12 + diff totals (+green / -red, gap4)
   │  ├─ optional tags chip line min-h16
   │  └─ GridRailAgentRows
   │     ├─ >2 agents: optional AgentSummaryPill
   │     └─ AgentRow each [h22,gap5,px4,11px,line-height1,radius4,hover-fill]
   │        ├─ status dot8 (working9)
   │        ├─ provider brand SVG12
   │        ├─ truncated prompt OR session title OR agent id (secondary)
   │        ├─ optional model [mono11,max-width76,muted]
   │        └─ age now / Nm / Nh [min-width22,right aligned,tabular,muted]
   └─ optional Alt-held jump number [absolute left4, vertical center,mono,accent]
```

Detailed card root: `flex gap-1.5 pl-1 pt-1.5 pb-[7px] pr-1.5`, radius8, border1 transparent; selected border #2a2a31 and selected-fill; unselected transparent with hover-fill; transition background/border150ms. Compact card h32,pl4,py4,gap6; chip variants min-h32. List inset L/R6,T2,B8; vertical gap4 (`RailChrome.tsx:130`). Group header sticky top0 with top padding4, label h28 px8 radius6,12px/600,line16.

Default prefs (`railPrefs.ts:33`): workspace grouping, manual sort, detailed cards, tag icon mode, compact agent activity; properties status, unread, checkout, pr, diff, task, inline-agents. CI/tags/context absent by default. Card with <=2 agents shows all rows; >2 shows summary, full list expands with grid-rows0fr→1fr 180ms. `activity.prompt.trim || session.title || session.agent` is the agent line; `activity.last_message` is stored as `trailing` but current GridRailAgentRows does NOT render it. No latest-message second line. No provider text label unless prompt/title falls back to agent id; shell adds ` · provider`.

Checkout/PR/CI: current detailed card renders a SINGLE checkout line, PR as an icon (not #number) coloured muted for draft/closed, accent for merged, red failing, green passing, amber otherwise. Checks string is sr-only. Diff totals are +N/-N. `GridRailPrDiffLine.tsx` defines a separate #PR / checks string / diff / task / context row, but is not imported by active GridRailRowView. Compact cards do show #PR and truncated mono branch (max96px) when properties are enabled. Do not add that old fact row to a current detailed card.

Hover card (`GridRailHoverCard.tsx:33`): portal, width300px,p12,gap8; title; workspace, Local/remote, first checkout/branch, first provider model/id and +N agents; tags; amber Waiting for your answer; optional PR link #number and title. No latest-message text.

## 3. Pane chrome and stacks

`SessionPane.tsx:557`: frame → header → notices → real terminal/body. Frame uses focus attrs; border1,radius10,overflow hidden. Header h30/min-h30, left inset10/right4,gap8,bottom border1 divider; 12px/500,tracking-.005em. Header identity flex gap8 min-width0 overflow-hidden: live status7px → provider glyph16 slot/SVG13 → editable truncated title → optional task/watch/checkout/tags/ACP/profile badges → optional `· project-basename` subtitle11px. Provider glyph hidden at pane width<=360; branch/subtitle <=400. There is no always-visible provider-name text beside the session name.

Actions at right (`SessionPane.tsx:833`): context meter, ended-state chip (hidden<=490px), restart/wake/reconnect if not live, Terminal actions ellipsis, Expand/Collapse (hidden<=150), New pane plus, Close. Optional unread Inbox button before actions. Mini buttons visible22×22,1px gaps,radius6; narrow<=280 becomes20,<=200 becomes18; target often enlarged to28 independently of visible box. Hover uses light transparent ground and primary ink; expanded button info16% tint.

Focus (`components/ui/paneFocus.css:8`): full border `--border-focus #6f6f7a`, full header raised/card-hover #1c1c20; none border #2a2a31, header `color-mix(card-bg55%,content-bg)` ≈ #0f0f11; dim border mix(focus45%,border) ≈ #494952, dim header mix(raised45%,normal) ≈ #151518. Unfocused titles become secondary when a sibling `.pane.focus` exists. Rounded frame remains same; no blue focused outline.

`StackTabs.tsx` / `ui/StackTab.tsx`: strip h26,bg card #131316,bottom divider,scroll-x; tab h100%,px8,gap4,border-right divider,12px/500,white-space nowrap,cursor pointer,background transition120ms. Active content-bg #0a0a0b + primary; inactive muted, hover primary6% transparent. Label max width token; background needs-input dot6px amber; close hidden except hover/focus; tab capacity tabular hint and controls as excerpt; StackTabs itself renders no add/overflow button.

## 4. Status visuals (implementation precedence)

| State | Pane header | Active rail grid/agent |
|---|---|---|
| Spawning/starting | dot7 accent #5c8fff; 1.4s `steps(4,end)` opacity pulse 1→.35→1 | solid blue8 grid/8 agent; NO pulse |
| Working | dot7 info #7cb7ff; same pulse | ring9,border1.5 accent #5c8fff,right transparent; spin1s linear infinite; reduced motion disables |
| Needs input | solid7 amber `--warn #f59e0b`, static | solid8 amber, static |
| Idle/ready | solid7 `--text-muted #7a7a85`, static | grid8 text-faint; agent8 text-faint opacity.6 |
| Unavailable | dot7 card-bg center + border1.5 text-secondary #b4b4bd | agent hollow8 border1.5 secondary; grid defaults solid text-faint |
| Done | child header/roster StatusLabel dot6 `--ok #4ade80` | grid status-class done green8 (normal gridStatus does not derive delegation completion) |
| Failed | child StatusLabel dot6 `--stop #ef4444` | exited grid red8; ordinary agent-row fallback hollow secondary |
| Stalled/quiet | child dot6 muted #7a7a85, tooltip includes heuristic reason | working >10 minutes: hollow info border, grid6/agent8, tooltip No recent update |

Sources `ui/PaneControls.tsx:112`; `SessionPane.tsx:176,816`; `ChildrenRoster.tsx:85`; `ui/StatusLabel.tsx:31`; `ui/rail/GridRailRowView.tsx:15`; `ui/rail/GridRailAgentRows.tsx:8`; `keyframes.css:88`. `docs/user/agent-status.md` says pane/grid share blue pulses and hollow unavailable; current rail implementation differs as above. Read-only task: discrepancy recorded here, documentation not edited.

## 5. Composer controls and launch composer

`ComposerControls.tsx:27,163`: maximum3 visible dropdown chips; remaining chips go in +N overflow. Generic primitive receives labels/options from caller (it does not hard-code Agent/Model/Effort/Checkout). Wrap flex row gap6,wrap; Send at far right. Pill h26,px8,gap6,radius9999,border1 #2a2a31,bg surface #131316,secondary12px/500; hover #1c1c20; disabled50%. Chevron label icon. Options menu starts4px below, options left-aligned; overflow fields right-aligned. Choice row min-h28,px12,12px/500,selected600 primary; hover surface-hover. Send h26,px12,accent #5c8fff ground/white #ffffff bold700 ink,radius9999,disabled40%,loading spinner.

Launch UI is a DOCKED form, not a terminal chat bar. `NewSessionComposer.tsx:133` → LaunchComposerHeader, Launch target segmented This grid/New grid, preset4-column cards, Agent select + Sessions stepper, per-slot launch cards, Task textarea, routing notes, footer Launch N sessions `Ctrl ↵`. Dock width560px,max48vw; rows38/1fr/56. Body horizontal20px,top14,bottom32,gap12,max556. Task min44/max160,px12,radius8,border1,card-bg. Footer action h32,px24,radius8.

`ui/LaunchSlotCard.tsx:85`: card p8,gap8,radius10,border1/card-bg. Header slot number mono11,width12 → provider SVG12 → roleLabel or provider label13/500 → source11 muted, edited amber with reset. Fields 2 columns,gap-x8/gap-y6; Agent, Model, Effort, Checkout. Select h28,px8,radius6,border1,content-bg,primary13/500. Edited select border warn55%. Checkout is a readout `This checkout · {workspaceName}`, not a dropdown: radius4,px8,py4,card-bg,12px. Effort options default/low/medium/high/xhigh/max. Model defaults/known IDs/custom input. Exact classes and provider labels in appendix.

## 6. Provider identity

All six icons are inline FilledMark SVGs in `components/icons.tsx`, no external icon assets; fill=currentColor,default14px,role small12/ui13. Provider brand colours (`theme.css:298`): Claude `--claude #d97757`; Antigravity `--antigravity #a78bfa`; Codex/OpenCode/Cursor/Grok their respective tokens alias `--text-primary #f4f4f6`. Pane headers use engineGlyphColor; rail rows IconAgent brand. Launcher labels Claude Code, Codex, OpenCode, Cursor Agent, Grok Build, Antigravity. Hover/prompt fallback can use lowercase provider IDs. Raw SVG below.

### Claude — `ui/src/renderer/src/components/icons.tsx:966`

```svg
<svg width="14" height="14" viewBox="0 0 256 257" fill="currentColor" aria-hidden="true">
<path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0l10.63 1.426 4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999z" />
</svg>
```

### Codex — `ui/src/renderer/src/components/icons.tsx:974`

```svg
<svg width="14" height="14" viewBox="0 0 256 260" fill="currentColor" aria-hidden="true">
<path d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z" />
</svg>
```

### Opencode — `ui/src/renderer/src/components/icons.tsx:990`

```svg
<svg width="14" height="14" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
<path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
</svg>
```

### Cursor — `ui/src/renderer/src/components/icons.tsx:1002`

```svg
<svg width="14" height="14" viewBox="0 0 466.73 532.09" fill="currentColor" aria-hidden="true">
<path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
</svg>
```

### Grok — `ui/src/renderer/src/components/icons.tsx:1010`

```svg
<svg width="14" height="14" viewBox="0 0 256 246" fill="currentColor" aria-hidden="true">
<path d="M63.83 56.843c27.469-27.48 67.635-34.865 101.712-21.87l2.314.917c7.645 2.844 14.309 6.89 19.507 10.651l-28.857 13.342c-26.869-11.286-57.649-3.609-76.435 15.2c-25.405 25.414-30.539 69.484-.764 97.96L0 245.764c4.296-5.923 9.457-11.573 14.75-17.178l5.815-6.13l2.608-2.774c15.53-16.655 28.81-33.77 20.496-56.709l-.766-1.98c-14.592-35.497-6.094-77.096 20.928-104.15m156.956-21.587L256 0l-10.128 14.069c-21.094 29.716-30.456 48.424-21.11 88.659l-.065-.065c7.23 30.728-.503 64.803-25.472 89.802c-31.478 31.538-81.852 38.558-123.336 10.17l28.923-13.407c26.476 10.41 55.442 5.839 76.26-15.003c20.818-20.844 25.493-51.2 15.03-76.462c-1.989-4.79-7.952-5.992-12.125-2.909L98.87 157.755L220.786 35.147z" />
</svg>
```

### Antigravity — `ui/src/renderer/src/components/icons.tsx:982`

```svg
<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
<path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" />
</svg>
```

## 7. Primitives and fonts

`components/ui/` uses individual semantic components and shared recipes. No central Badge.tsx or Kbd.tsx: Chip, StatusLabel, PaneHeadBadge, Count, ProfileBadge/etc. serve badges; KeyCap, KeyChip, HintKey/ShortcutHint serve keyboard hints. Button has md/sm/lg and the exact variant union in appendix (including legacy variants used by app). Core primary/secondary/field/ghost/link/danger/danger-solid/icon; rail subtle-icon/compact-icon/disclosure-icon; pane uses PaneHeadButton. Chip variants state/provider/count/compound/removable/choice, tones default/info/success/warning/danger. Select is a custom popup/listbox (no native select). Tooltip uses a portal, floating glass radius/shadow, max280,12px/500,line1.35,padding4×7; hover delayed400ms, focus immediate. Menu/ContextMenu/ActionMenu share overlay recipes. Card, Text, Stack, Inline, Icon, Dialog, PopoverPanel, Segmented, Field, TextInput, TextArea, Switch, Slider and NumberField provide the other basic roles. Full filename inventory and exact recipes follow.

Loaded UI sans: Plus Jakarta Sans 400/500/600/700. Mono: JetBrains Mono400/500/700. Display serif: Source Serif4 400/500/600 (app main only; harness omits serif imports). `main.tsx:6`; `tailwind.css:16`; `theme.css:1781`. Bundled via @fontsource package CSS/WOFF2, Vite dropWoffFallback removes WOFF fallbacks (`ui/vite.config.ts:8`). Sans fallback system-ui/-apple-system/BlinkMacSystemFont/Segoe UI; mono SF Mono/Menlo/Monaco/Consolas. Base body13px/500; antialiased; scrollbar6px. Small12, xs11, label11/700 upper/.1em tracking/14px leading; ui13/500, line1.5. Font dimensions depend on shell zoom; values here are zoom1.

## 8. Images and screenshots

Tracked-file scan finds one app screenshot under docs/.github: `.github/assets/houston-grid.webp`. README references that file. App assets: `ui/src/renderer/src/assets/brand-mark-{32,64,96}.png`; `assets/backgrounds/graphite.webp`, `paper.webp` (background art, not screenshots). Branding/promo artwork: `ui/resources/branding/houston-mascot.png`, `houston-icon-detail.png`, `houston-icon-small.png`, `houston-promo-background.png`; `branding/animations/exports/keyframes.png`, `gallery-overview.png`. Harness `ui/src/renderer/harness/banner.svg`. Icons also `ui/resources/icon.png`, `icon-small.svg`, `icon-symbolic.svg`, `mark-vector.svg`, hicolor PNG sizes; `src-tauri/icons/*` and `src-tauri/icons/tray/*`; mascot layered images under `components/ui/mascotAssets/` and `ui/resources/branding/animations/layers/`. These are product artwork, not app captures. See inventory below for literal paths.

## 9. Plain-browser rendering

Yes: Vite visual harness entry `ui/src/renderer/harness/index.html`, `harness/main.tsx:16` chooses `?story=...`, `?theme=graphite`. From repository: `cd ui` then `bun x --no-install vite --host 127.0.0.1 --port 5173`; open `http://127.0.0.1:5173/harness/index.html?story=ui-primitives&theme=graphite`. This command is inferred directly from Vite root/config and installed vite dependency (no dedicated dev script in package.json). Command NOT executed for this task. No daemon required for specimen/fake-client stories; full App needs daemon and native bridges. Index route `/harness/index.html` lists stories. `ui-primitives` forcibly disables animations/transitions via data-static-visual and resets scroll. Rail/pane/composer stories are listed below, alongside fixtures; native browser/PTY behaviour is not represented by static specimens.

## Token ledger: exact source values

This includes tokens referenced by the chrome recipes, plus typography/spacing/radius/control definitions. Graphite declarations precede the paper block; later unscoped root tokens supply geometry. Material-local text-faint overrides are significant: shell #52525a; inset #54545c; raised/overlay #5b5b62; base mixed ≈#4f4f57. Global text-muted remains #7a7a85 in shell.

| Token | Declaration | Expanded graphite value | theme.css line |
|---|---|---|---|
| `--accent` | `#5c8fff` | `#5c8fff` | 148 |
| `--accent-foreground` | `var(--text-primary)` | `#f4f4f6` | 394 |
| `--accent-hover` | `color-mix(in srgb, #5c8fff 85%, white)` | `color-mix(in srgb, #5c8fff 85%, white)` | 151 |
| `--accent-ink` | `#0a0a0b` | `#0a0a0b` | 149 |
| `--accent-muted` | `color-mix(in srgb, #5c8fff 15%, transparent)` | `color-mix(in srgb, #5c8fff 15%, transparent)` | 152 |
| `--accent-surface` | `color-mix(in srgb, var(--accent) 12%, var(--card-bg))` | `color-mix(in srgb, #5c8fff 12%, #131316)` | 393 |
| `--animate-ease-menu` | `var(--motion-menu-ease)` | `cubic-bezier(0.16, 1, 0.3, 1)` | 1796 |
| `--animate-ease-panel` | `var(--motion-menu-ease)` | `cubic-bezier(0.16, 1, 0.3, 1)` | 1795 |
| `--animate-t-fast` | `var(--motion-fast-t)` | `0.12s` | 1798 |
| `--animate-t-panel` | `var(--motion-menu-t)` | `0.16s` | 1799 |
| `--antigravity` | `#a78bfa` | `#a78bfa` | 299 |
| `--background` | `var(--content-bg)` | `#0a0a0b` | 349 |
| `--border` | `#2a2a31` | `#2a2a31` | 124 |
| `--border-active` | `color-mix(in srgb, var(--accent) 65%, transparent)` | `color-mix(in srgb, #5c8fff 65%, transparent)` | 386 |
| `--border-choice-radio` | `1.5px` | `1.5px` | 1395 |
| `--border-focus` | `#6f6f7a` | `#6f6f7a` | 126 |
| `--border-hover` | `#35353d` | `#35353d` | 125 |
| `--border-width-hairline` | `1px` | `1px` | 1343 |
| `--button-block-padding` | `5px` | `5px` | 1342 |
| `--bw-window-control-focus` | `1.5px` | `1.5px` | 1601 |
| `--card-bg` | `#131316` | `#131316` | 122 |
| `--card-hover` | `#1c1c20` | `#1c1c20` | 123 |
| `--claude` | `#d97757` | `#d97757` | 298 |
| `--codex` | `var(--text-primary)` | `#f4f4f6` | 300 |
| `--content-bg` | `#0a0a0b` | `#0a0a0b` | 121 |
| `--cursor` | `var(--text-primary)` | `#f4f4f6` | 302 |
| `--danger` | `var(--stop)` | `#ef4444` | 293 |
| `--divider` | `#1e1e22` | `#1e1e22` | 353 |
| `--focus-ring` | `#aab0c2` | `#aab0c2` | 352 |
| `--font-mono` | `'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace` | `'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace` | 1782 |
| `--font-sans` | `'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | `'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | 1781 |
| `--glass` | `var(--glass-bg)` | `rgba(20,20,24,.90)` | 367 |
| `--glass-bg` | `rgba(20,20,24,.90)` | `rgba(20,20,24,.90)` | 366 |
| `--glass-rail-shadow` | `none` | `none` | 362 |
| `--glass-topbar-shadow` | `none` | `none` | 363 |
| `--grok` | `var(--text-primary)` | `#f4f4f6` | 303 |
| `--h-action-footer` | `56px` | `56px` | 1433 |
| `--h-agent-row` | `22px` | `22px` | 1548 |
| `--h-chip-dismiss` | `16px` | `16px` | 108 |
| `--h-context-menu-item` | `30px` | `30px` | 1551 |
| `--h-context-menu-title` | `48px` | `48px` | 1552 |
| `--h-ctl` | `28px` | `28px` | 1547 |
| `--h-ctl-mini` | `22px` | `22px` | 1584 |
| `--h-disclosure-hit` | `28px` | `28px` | 1641 |
| `--h-empty-action` | `36px` | `36px` | 1550 |
| `--h-pane-icon-button-compact` | `20px` | `20px` | 433 |
| `--h-pane-icon-button-narrow` | `18px` | `18px` | 434 |
| `--h-pill` | `26px` | `26px` | 1546 |
| `--h-primary-action` | `32px` | `32px` | 1434 |
| `--h-primitives-preview` | `160px` | `160px` | 1371 |
| `--h-rail-filter-badge` | `12px` | `12px` | 1564 |
| `--h-rail-filter-button` | `24px` | `24px` | 1563 |
| `--h-rail-group-header` | `32px` | `32px` | 1565 |
| `--h-rail-search` | `30px` | `30px` | 1567 |
| `--h-rail-segment` | `22px` | `22px` | 1566 |
| `--h-railhead` | `38px` | `38px` | 1541 |
| `--h-row` | `28px` | `28px` | 1608 |
| `--h-tag-chip` | `16px` | `16px` | 1648 |
| `--h-task-input-max` | `160px` | `160px` | 1651 |
| `--h-task-input-min` | `44px` | `44px` | 1650 |
| `--h-top` | `38px` | `38px` | 1540 |
| `--h-workspace-drop-indicator` | `2px` | `2px` | 1640 |
| `--hover-fill` | `#ffffff0d` | `#ffffff0d` | 396 |
| `--hover-strong` | `#ffffff14` | `#ffffff14` | 397 |
| `--info` | `#7cb7ff` | `#7cb7ff` | 295 |
| `--material-base-custom-worst` | `#2b2b2f` | `#2b2b2f` | 373 |
| `--material-base-glass-worst` | `#1e4157` | `#1e4157` | 368 |
| `--material-inset-text-faint` | `#54545c` | `#54545c` | 377 |
| `--material-inset-text-muted` | `#7e7e88` | `#7e7e88` | 376 |
| `--material-overlay-glass-text-faint` | `#595961` | `#595961` | 385 |
| `--material-overlay-glass-text-muted` | `#7f7f8a` | `#7f7f8a` | 384 |
| `--material-overlay-glass-worst` | `#12161f` | `#12161f` | 371 |
| `--material-overlay-text-faint` | `#5b5b62` | `#5b5b62` | 383 |
| `--material-overlay-text-muted` | `#83838d` | `#83838d` | 382 |
| `--material-raised-glass-text-faint` | `#595961` | `#595961` | 381 |
| `--material-raised-glass-text-muted` | `#7f7f8a` | `#7f7f8a` | 380 |
| `--material-raised-glass-worst` | `#12161f` | `#12161f` | 370 |
| `--material-raised-text-faint` | `#5b5b62` | `#5b5b62` | 379 |
| `--material-raised-text-muted` | `#83838d` | `#83838d` | 378 |
| `--material-shell-custom-worst` | `#36363a` | `#36363a` | 372 |
| `--material-shell-glass-worst` | `#10243f` | `#10243f` | 369 |
| `--material-shell-text-faint` | `#52525a` | `#52525a` | 375 |
| `--material-shell-text-muted` | `var(--text-muted)` | `#7a7a85` | 374 |
| `--motion-menu-ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | `cubic-bezier(0.16, 1, 0.3, 1)` | 1789 |
| `--offset-workspace-drop-indicator` | `-1px` | `-1px` | 1467 |
| `--ok` | `#4ade80` | `#4ade80` | 289 |
| `--opacity-context-menu-disabled` | `0.45` | `0.45` | 1573 |
| `--opacity-inactive` | `0.45` | `0.45` | 1397 |
| `--opacity-shortcuts-disabled` | `0.45` | `0.45` | 1572 |
| `--opacity-workspace-row-dragged` | `0.45` | `0.45` | 1575 |
| `--opencode` | `var(--text-primary)` | `#f4f4f6` | 301 |
| `--pane-focus-border-dim` | `color-mix(in srgb, var(--border-focus) 45%, var(--border))` | `color-mix(in srgb, #6f6f7a 45%, #2a2a31)` | 1391 |
| `--pane-focus-head-dim` | `color-mix(in srgb, var(--raised) 45%, var(--session-terminal-header-bg))` | `color-mix(in srgb, #1c1c20 45%, color-mix(in srgb, #131316 55%, #0a0a0b))` | 1392 |
| `--pane-frame-border-width` | `1px` | `1px` | 1390 |
| `--pane-head-border-muted` | `color-mix(in srgb, var(--border) 55%, transparent)` | `color-mix(in srgb, #2a2a31 55%, transparent)` | 1393 |
| `--pane-head-divider-muted` | `color-mix(in srgb, var(--divider) 55%, transparent)` | `color-mix(in srgb, #1e1e22 55%, transparent)` | 1394 |
| `--pane-head-leading-inset` | `10px` | `10px` | 1389 |
| `--panel` | `var(--rail-bg)` | `#0f0f12` | 350 |
| `--panel-badge-border` | `color-mix(in srgb,var(--info) 20%,transparent)` | `color-mix(in srgb,#7cb7ff 20%,transparent)` | 1737 |
| `--panel-badge-fill` | `linear-gradient(135deg,color-mix(in srgb,var(--info) 15%,transparent),color-mix(in srgb,var(--success) 15%,transparent))` | `linear-gradient(135deg,color-mix(in srgb,#7cb7ff 15%,transparent),color-mix(in srgb,#4ade80 15%,transparent))` | 1736 |
| `--panel-button-primary-border` | `color-mix(in srgb,var(--accent) 25%,transparent)` | `color-mix(in srgb,#5c8fff 25%,transparent)` | 1762 |
| `--panel-button-primary-fill` | `color-mix(in srgb,var(--accent) 15%,transparent)` | `color-mix(in srgb,#5c8fff 15%,transparent)` | 1761 |
| `--panel-button-primary-hover` | `color-mix(in srgb,var(--accent) 25%,transparent)` | `color-mix(in srgb,#5c8fff 25%,transparent)` | 1763 |
| `--panel-control-hover` | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.08)` | 1733 |
| `--panel-count-border` | `rgba(255,255,255,0.06)` | `rgba(255,255,255,0.06)` | 1732 |
| `--panel-count-fill` | `rgba(255,255,255,0.04)` | `rgba(255,255,255,0.04)` | 1731 |
| `--panel-dialog-border` | `color-mix(in srgb,var(--border) 60%,transparent)` | `color-mix(in srgb,#2a2a31 60%,transparent)` | 1754 |
| `--panel-dialog-divider` | `color-mix(in srgb,var(--border) 40%,transparent)` | `color-mix(in srgb,#2a2a31 40%,transparent)` | 1755 |
| `--panel-disabled-opacity` | `0.72` | `0.72` | 1730 |
| `--panel-edge` | `color-mix(in srgb,var(--border) 40%,transparent)` | `color-mix(in srgb,#2a2a31 40%,transparent)` | 1756 |
| `--panel-editor-background` | `color-mix(in srgb,var(--card-bg) 50%,transparent)` | `color-mix(in srgb,#131316 50%,transparent)` | 1757 |
| `--panel-editor-border` | `color-mix(in srgb,var(--border) 60%,transparent)` | `color-mix(in srgb,#2a2a31 60%,transparent)` | 1758 |
| `--panel-error-border` | `color-mix(in srgb,var(--danger) 30%,transparent)` | `color-mix(in srgb,#ef4444 30%,transparent)` | 1759 |
| `--panel-error-fill` | `color-mix(in srgb,var(--danger) 10%,transparent)` | `color-mix(in srgb,#ef4444 10%,transparent)` | 1760 |
| `--panel-field-border` | `color-mix(in srgb,var(--border) 60%,transparent)` | `color-mix(in srgb,#2a2a31 60%,transparent)` | 1752 |
| `--panel-field-fill` | `color-mix(in srgb,var(--card-bg) 50%,transparent)` | `color-mix(in srgb,#131316 50%,transparent)` | 1751 |
| `--panel-muted-border` | `color-mix(in srgb,var(--border) 60%,transparent)` | `color-mix(in srgb,#2a2a31 60%,transparent)` | 1739 |
| `--panel-notice-danger-border` | `color-mix(in srgb,var(--danger) 42%,transparent)` | `color-mix(in srgb,#ef4444 42%,transparent)` | 1740 |
| `--panel-notice-danger-fill` | `color-mix(in srgb,var(--danger) 11%,transparent)` | `color-mix(in srgb,#ef4444 11%,transparent)` | 1741 |
| `--panel-notice-danger-strong-border` | `color-mix(in srgb,var(--danger) 30%,transparent)` | `color-mix(in srgb,#ef4444 30%,transparent)` | 1744 |
| `--panel-notice-danger-strong-fill` | `color-mix(in srgb,var(--danger) 10%,transparent)` | `color-mix(in srgb,#ef4444 10%,transparent)` | 1745 |
| `--panel-notice-warn-border` | `color-mix(in srgb,var(--warn) 42%,transparent)` | `color-mix(in srgb,#f59e0b 42%,transparent)` | 1742 |
| `--panel-notice-warn-fill` | `color-mix(in srgb,var(--warn) 11%,transparent)` | `color-mix(in srgb,#f59e0b 11%,transparent)` | 1743 |
| `--panel-pill-fill` | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.03)` | 1734 |
| `--panel-pill-hover` | `rgba(255,255,255,0.06)` | `rgba(255,255,255,0.06)` | 1735 |
| `--panel-pill-selected-border` | `color-mix(in srgb,var(--accent) 30%,transparent)` | `color-mix(in srgb,#5c8fff 30%,transparent)` | 1750 |
| `--panel-pill-selected-fill` | `color-mix(in srgb,var(--accent) 15%,transparent)` | `color-mix(in srgb,#5c8fff 15%,transparent)` | 1749 |
| `--panel-save-border` | `color-mix(in srgb,var(--accent) 25%,transparent)` | `color-mix(in srgb,#5c8fff 25%,transparent)` | 1747 |
| `--panel-save-fill` | `color-mix(in srgb,var(--accent) 15%,transparent)` | `color-mix(in srgb,#5c8fff 15%,transparent)` | 1746 |
| `--panel-save-hover` | `color-mix(in srgb,var(--accent) 25%,transparent)` | `color-mix(in srgb,#5c8fff 25%,transparent)` | 1748 |
| `--panel-surface-border` | `color-mix(in srgb,var(--border) 40%,transparent)` | `color-mix(in srgb,#2a2a31 40%,transparent)` | 1738 |
| `--panel-switch-border-on` | `color-mix(in srgb,var(--accent) 70%,transparent)` | `color-mix(in srgb,#5c8fff 70%,transparent)` | 1753 |
| `--primary-foreground` | `#ffffff` | `#ffffff` | 388 |
| `--rail-bg` | `#0f0f12` | `#0f0f12` | 120 |
| `--raised` | `var(--card-hover)` | `#1c1c20` | 351 |
| `--selected-fill` | `#ffffff1a` | `#ffffff1a` | 395 |
| `--session-terminal-header-bg` | `color-mix(in srgb, #131316 55%, #0a0a0b)` | `color-mix(in srgb, #131316 55%, #0a0a0b)` | 139 |
| `--shadow-1` | `var(--shadow-md)` | `0 4px 16px rgba(0, 0, 0, 0.5)` | 132 |
| `--shadow-panel-check-popover` | `0 18px 44px -18px #000c` | `0 18px 44px -18px #000c` | 1277 |
| `--shell-zoom` | `1` | `1` | 1537 |
| `--space-0-25` | `1px` | `1px` | 1340 |
| `--space-0-5` | `2px` | `2px` | 1289 |
| `--space-0-75` | `3px` | `3px` | 1290 |
| `--space-1` | `4px` | `4px` | 1297 |
| `--space-1-5` | `6px` | `6px` | 1299 |
| `--space-1-75` | `7px` | `7px` | 1344 |
| `--space-2` | `8px` | `8px` | 1345 |
| `--space-2-25` | `9px` | `9px` | 1346 |
| `--space-2-5` | `10px` | `10px` | 1347 |
| `--space-3` | `12px` | `12px` | 1348 |
| `--space-4` | `16px` | `16px` | 1349 |
| `--space-4-5` | `20px` | `20px` | 1350 |
| `--space-5` | `24px` | `24px` | 1351 |
| `--space-6` | `32px` | `32px` | 1352 |
| `--space-7` | `28px` | `28px` | 1446 |
| `--space-action-footer-gap` | `10px` | `10px` | 1420 |
| `--space-action-footer-inline` | `14px` | `14px` | 1419 |
| `--space-card-grid-gap` | `7px` | `7px` | 1417 |
| `--space-choice-x` | `9px` | `9px` | 97 |
| `--space-context-menu-gap` | `1px` | `1px` | 1453 |
| `--space-context-menu-icon-column` | `18px` | `18px` | 1464 |
| `--space-context-menu-pad` | `5px` | `5px` | 1454 |
| `--space-context-menu-section-bottom` | `1px` | `1px` | 1460 |
| `--space-context-menu-section-top` | `3px` | `3px` | 1459 |
| `--space-context-menu-section-x` | `8px` | `8px` | 1458 |
| `--space-context-menu-separator-y` | `6px` | `6px` | 1461 |
| `--space-context-menu-title-gap` | `2px` | `2px` | 1457 |
| `--space-context-menu-title-x` | `10px` | `10px` | 1455 |
| `--space-context-menu-title-y` | `7px` | `7px` | 1456 |
| `--space-disclosure-nudge` | `3px` | `3px` | 1448 |
| `--space-editor-menu-gap` | `14px` | `14px` | 1602 |
| `--space-editor-menu-y` | `5px` | `5px` | 1603 |
| `--space-fullscreen-message` | `14px` | `14px` | 1354 |
| `--space-keycap-block` | `1px` | `1px` | 1385 |
| `--space-keycap-inline` | `7px` | `7px` | 1384 |
| `--space-keycap-x` | `7px` | `7px` | 1468 |
| `--space-keycap-y` | `2px` | `2px` | 1469 |
| `--space-menu-item-x` | `7px` | `7px` | 1451 |
| `--space-pane-notice-block` | `3px` | `3px` | 476 |
| `--space-panel-empty-bottom` | `58px` | `58px` | 1294 |
| `--space-pixel` | `1px` | `1px` | 1298 |
| `--space-rail-keycap-x` | `4px` | `4px` | 1470 |
| `--space-shortcut-keycap-block` | `1px` | `1px` | 172 |
| `--space-shortcut-keycap-inline` | `7px` | `7px` | 171 |
| `--space-task-field-block` | `11px` | `11px` | 1418 |
| `--space-workspace-empty-list-x` | `10px` | `10px` | 1447 |
| `--status-blocked-bg` | `color-mix(in srgb, #ef4444 14%, transparent)` | `color-mix(in srgb, #ef4444 14%, transparent)` | 308 |
| `--status-blocked-text` | `#f09595` | `#f09595` | 309 |
| `--status-doing-bg` | `color-mix(in srgb, #7cb7ff 14%, transparent)` | `color-mix(in srgb, #7cb7ff 14%, transparent)` | 304 |
| `--status-doing-text` | `#7cb7ff` | `#7cb7ff` | 305 |
| `--status-done-bg` | `color-mix(in srgb, #4ade80 14%, transparent)` | `color-mix(in srgb, #4ade80 14%, transparent)` | 310 |
| `--status-done-text` | `#79d79a` | `#79d79a` | 311 |
| `--status-todo-bg` | `color-mix(in srgb, #f59e0b 14%, transparent)` | `color-mix(in srgb, #f59e0b 14%, transparent)` | 306 |
| `--status-todo-text` | `#f0b04f` | `#f0b04f` | 307 |
| `--stop` | `#ef4444` | `#ef4444` | 291 |
| `--success` | `#4ade80` | `#4ade80` | 297 |
| `--surface` | `var(--card-bg)` | `#131316` | 346 |
| `--surface-active` | `var(--card-hover)` | `#1c1c20` | 348 |
| `--surface-hover` | `var(--card-hover)` | `#1c1c20` | 347 |
| `--sz-brand-mark` | `32px` | `32px` | 1543 |
| `--sz-disclosure-icon` | `18px` | `18px` | 1642 |
| `--sz-pane-status-dot` | `7px` | `7px` | 432 |
| `--sz-rail-compact-action` | `24px` | `24px` | 1645 |
| `--sz-rail-row-action` | `20px` | `20px` | 1643 |
| `--sz-rail-update-button` | `32px` | `32px` | 1562 |
| `--sz-window-control-disc` | `20px` | `20px` | 1587 |
| `--sz-workspace-selection-rail` | `3px` | `3px` | 1644 |
| `--task-inline-control-height` | `24px` | `24px` | 245 |
| `--text-faint` | `color-mix(in srgb, #7a7a85 62%, #0a0a0b)` | `color-mix(in srgb, #7a7a85 62%, #0a0a0b)` | 156 |
| `--text-form-default` | `var(--text-primary)` | `#f4f4f6` | 1408 |
| `--text-key-hint` | `color-mix(in srgb, currentColor 55%, transparent)` | `color-mix(in srgb, currentColor 55%, transparent)` | 1398 |
| `--text-muted` | `#7a7a85` | `#7a7a85` | 155 |
| `--text-on-accent` | `#ffffff` | `#ffffff` | 150 |
| `--text-primary` | `#f4f4f6` | `#f4f4f6` | 153 |
| `--text-secondary` | `#b4b4bd` | `#b4b4bd` | 154 |
| `--tool-code-bg` | `#000000` | `#000000` | 312 |
| `--tr-control-width-medium` | `200px` | `200px` | 483 |
| `--tr-icon-small-size` | `12px` | `12px` | 1533 |
| `--tr-radius-badge` | `3px` | `3px` | 1264 |
| `--tr-radius-button` | `8px` | `8px` | 1256 |
| `--tr-radius-card` | `12px` | `12px` | 1257 |
| `--tr-radius-input` | `4px` | `4px` | 1255 |
| `--tr-radius-md` | `10px` | `10px` | 1254 |
| `--tr-radius-menu` | `10px` | `10px` | 1259 |
| `--tr-radius-palette-swatch` | `3px` | `3px` | 1308 |
| `--tr-radius-pill` | `9999px` | `9999px` | 1262 |
| `--tr-radius-shortcut-fixed` | `2px` | `2px` | 1253 |
| `--tr-radius-skeleton-line` | `3px` | `3px` | 130 |
| `--tr-radius-sm` | `6px` | `6px` | 1251 |
| `--tr-radius-ssh-panel` | `14px` | `14px` | 1258 |
| `--tr-radius-surface-circle` | `50%` | `50%` | 1267 |
| `--tr-radius-surface-control` | `7px` | `7px` | 1266 |
| `--tr-radius-surface-full` | `999px` | `999px` | 1268 |
| `--tr-radius-surface-small` | `5px` | `5px` | 1265 |
| `--tr-radius-terminal-skeleton-line` | `3px` | `3px` | 448 |
| `--tr-radius-theme-preview` | `3px` | `3px` | 1307 |
| `--tr-radius-workspace-drop-indicator` | `1px` | `1px` | 1261 |
| `--tr-radius-workspace-selection-rail` | `3px` | `3px` | 1260 |
| `--tr-radius-xs` | `3px` | `3px` | 1252 |
| `--tr-spinner-border` | `2px` | `2px` | 1445 |
| `--tr-text-2xl` | `20px` | `20px` | 1481 |
| `--tr-text-3xl` | `24px` | `24px` | 1482 |
| `--tr-text-base` | `13px` | `13px` | 1477 |
| `--tr-text-body-leading` | `calc(1.6 - (var(--shell-zoom) - 1) * 0.15)` | `calc(1.6 - (1 - 1) * 0.15)` | 1504 |
| `--tr-text-body-size` | `calc(15px + var(--tr-type-zoom-delta))` | `calc(15px + calc((1 - 1) * 15px))` | 1502 |
| `--tr-text-body-weight` | `400` | `400` | 1503 |
| `--tr-text-brand-tracking` | `-0.025em` | `-0.025em` | 1489 |
| `--tr-text-browser-count` | `8.5px` | `8.5px` | 1272 |
| `--tr-text-context-menu-heading-weight` | `650` | `650` | 1578 |
| `--tr-text-display-family` | `var(--f-serif)` | `'Source Serif 4', 'Iowan Old Style', 'Times New Roman', Georgia, serif` | 1492 |
| `--tr-text-display-leading` | `1.15` | `1.15` | 1488 |
| `--tr-text-display-size` | `calc(44px + var(--tr-type-zoom-delta))` | `calc(44px + calc((1 - 1) * 15px))` | 1487 |
| `--tr-text-display-weight` | `round(nearest, 500 - 80 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 500 - 80 * max(0, 1 - 1), 100)` | 1491 |
| `--tr-text-editor-leading` | `1.75` | `1.75` | 1728 |
| `--tr-text-empty-leading` | `1.65` | `1.65` | 1490 |
| `--tr-text-field-label-tracking` | `0.06em` | `0.06em` | 1507 |
| `--tr-text-file-breadcrumb` | `11.5px` | `11.5px` | 1473 |
| `--tr-text-file-status` | `10.5px` | `10.5px` | 1474 |
| `--tr-text-filter-badge-size` | `9px` | `9px` | 1583 |
| `--tr-text-heading-size` | `calc(22px + var(--tr-type-zoom-delta))` | `calc(22px + calc((1 - 1) * 15px))` | 1496 |
| `--tr-text-heading-tracking` | `-0.014em` | `-0.014em` | 1498 |
| `--tr-text-heading-weight` | `round(nearest, 700 - 240 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 700 - 240 * max(0, 1 - 1), 100)` | 1497 |
| `--tr-text-inspector-compact-size` | `12.5px` | `12.5px` | 1475 |
| `--tr-text-label-leading` | `14px` | `14px` | 1518 |
| `--tr-text-label-size` | `calc(11px + var(--tr-type-zoom-delta))` | `calc(11px + calc((1 - 1) * 15px))` | 1515 |
| `--tr-text-label-tracking` | `0.1em` | `0.1em` | 1517 |
| `--tr-text-label-transform` | `uppercase` | `uppercase` | 1519 |
| `--tr-text-label-weight` | `round(nearest, 700 - 240 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 700 - 240 * max(0, 1 - 1), 100)` | 1516 |
| `--tr-text-lg` | `16px` | `16px` | 1479 |
| `--tr-text-md` | `14px` | `14px` | 1478 |
| `--tr-text-meta` | `11.5px` | `11.5px` | 1485 |
| `--tr-text-nav-weight` | `500` | `500` | 1580 |
| `--tr-text-overview-head` | `12.5px` | `12.5px` | 223 |
| `--tr-text-overview-meta` | `11.5px` | `11.5px` | 224 |
| `--tr-text-overview-state` | `11.5px` | `11.5px` | 225 |
| `--tr-text-pane-header-tracking` | `-0.005em` | `-0.005em` | 1520 |
| `--tr-text-panel-launcher` | `13.5px` | `13.5px` | 1275 |
| `--tr-text-profile-description-leading` | `1.45` | `1.45` | 170 |
| `--tr-text-rail-keycap-leading` | `1.3` | `1.3` | 1582 |
| `--tr-text-rail-keycap-size` | `9px` | `9px` | 1581 |
| `--tr-text-roster-detail-size` | `11.5px` | `11.5px` | 1611 |
| `--tr-text-roster-name-size` | `12.5px` | `12.5px` | 1610 |
| `--tr-text-row` | `12.5px` | `12.5px` | 1484 |
| `--tr-text-shortcut-group-tracking` | `0.04em` | `0.04em` | 157 |
| `--tr-text-shortcut-leading` | `1.45` | `1.45` | 174 |
| `--tr-text-sm` | `12px` | `12px` | 1476 |
| `--tr-text-small-leading` | `calc(1.45 - (var(--shell-zoom) - 1) * 0.15)` | `calc(1.45 - (1 - 1) * 0.15)` | 1514 |
| `--tr-text-small-size` | `calc(12px + var(--tr-type-zoom-delta))` | `calc(12px + calc((1 - 1) * 15px))` | 1512 |
| `--tr-text-small-weight` | `round(nearest, 500 - 80 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 500 - 80 * max(0, 1 - 1), 100)` | 1513 |
| `--tr-text-snug-leading` | `1.35` | `1.35` | 1505 |
| `--tr-text-subhead-size` | `calc(17px + var(--tr-type-zoom-delta))` | `calc(17px + calc((1 - 1) * 15px))` | 1499 |
| `--tr-text-subhead-tracking` | `-0.006em` | `-0.006em` | 1501 |
| `--tr-text-subhead-weight` | `round(nearest, 600 - 160 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 600 - 160 * max(0, 1 - 1), 100)` | 1500 |
| `--tr-text-surface-compact` | `10px` | `10px` | 1274 |
| `--tr-text-surface-micro` | `9px` | `9px` | 1273 |
| `--tr-text-tag-caption-tracking` | `0.04em` | `0.04em` | 468 |
| `--tr-text-tag-hint-leading` | `1.55` | `1.55` | 480 |
| `--tr-text-tag-title-weight` | `650` | `650` | 469 |
| `--tr-text-task-leading` | `18px` | `18px` | 1431 |
| `--tr-text-tight-leading` | `1.4` | `1.4` | 1506 |
| `--tr-text-tight-tracking` | `-0.01em` | `-0.01em` | 1508 |
| `--tr-text-title-size` | `calc(30px + var(--tr-type-zoom-delta))` | `calc(30px + calc((1 - 1) * 15px))` | 1493 |
| `--tr-text-title-tracking` | `-0.02em` | `-0.02em` | 1495 |
| `--tr-text-title-weight` | `round(nearest, 700 - 240 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 700 - 240 * max(0, 1 - 1), 100)` | 1494 |
| `--tr-text-ui-leading` | `calc(1.5 - (var(--shell-zoom) - 1) * 0.15)` | `calc(1.5 - (1 - 1) * 0.15)` | 1511 |
| `--tr-text-ui-size` | `calc(13px + var(--tr-type-zoom-delta))` | `calc(13px + calc((1 - 1) * 15px))` | 1509 |
| `--tr-text-ui-weight` | `round(nearest, 500 - 80 * max(0, var(--shell-zoom) - 1), 100)` | `round(nearest, 500 - 80 * max(0, 1 - 1), 100)` | 1510 |
| `--tr-text-update-weight` | `600` | `600` | 1579 |
| `--tr-text-xl` | `18px` | `18px` | 1480 |
| `--tr-text-xs` | `11px` | `11px` | 1472 |
| `--tr-width-shortcut-keycap` | `118px` | `118px` | 173 |
| `--tr-width-task-select` | `120px` | `120px` | 161 |
| `--w-composer-field-menu` | `200px` | `200px` | 1442 |
| `--w-composer-option-menu` | `160px` | `160px` | 1441 |
| `--w-context-menu` | `244px` | `244px` | 1555 |
| `--w-docked-form-panel` | `560px` | `560px` | 1436 |
| `--w-docked-form-viewport-max` | `48vw` | `48vw` | 1423 |
| `--w-editor-context-menu` | `180px` | `180px` | 1599 |
| `--w-form-body` | `556px` | `556px` | 1437 |
| `--w-pane-branch-chip` | `180px` | `180px` | 477 |
| `--w-pane-title-2xl` | `560px` | `560px` | 1382 |
| `--w-pane-title-3xl` | `720px` | `720px` | 1383 |
| `--w-pane-title-base` | `220px` | `220px` | 1379 |
| `--w-pane-title-lg` | `300px` | `300px` | 1380 |
| `--w-pane-title-md` | `180px` | `180px` | 1378 |
| `--w-pane-title-min` | `32px` | `32px` | 1373 |
| `--w-pane-title-narrow` | `12px` | `12px` | 1374 |
| `--w-pane-title-sm` | `140px` | `140px` | 1377 |
| `--w-pane-title-xl` | `420px` | `420px` | 1381 |
| `--w-pane-title-xs` | `100px` | `100px` | 1376 |
| `--w-pane-title-xxs` | `80px` | `80px` | 1375 |
| `--w-rail-keycap-min` | `16px` | `16px` | 1570 |
| `--w-rail-options` | `264px` | `264px` | 1561 |
| `--w-rail-specimen` | `256px` | `256px` | 1559 |
| `--w-shortcut-hint-footer` | `520px` | `520px` | 1569 |
| `--w-shortcut-keycap` | `118px` | `118px` | 1359 |
| `--w-stack-tab-label` | `110px` | `110px` | 478 |
| `--w-stepper-button` | `26px` | `26px` | 1443 |
| `--w-window-control` | `30px` | `30px` | 1586 |
| `--warn` | `#f59e0b` | `#f59e0b` | 290 |
| `--warning` | `var(--warn)` | `#f59e0b` | 294 |
| `--workspace-selection-fill-mix` | `12%` | `12%` | 1449 |
| `--workspace-selection-outline-mix` | `35%` | `35%` | 1450 |
| `--z-context` | `60` | `60` | 1773 |
| `--z-dropdown` | `46` | `46` | 1772 |
| `--z-leaf` | `10` | `10` | 1767 |
| `--z-overlay` | `40` | `40` | 1770 |
| `--z-popover` | `45` | `45` | 1771 |
| `--z-sticky` | `20` | `20` | 1768 |
| `--z-tooltip` | `1000` | `1000` | 1778 |
| `--z-window` | `100` | `100` | 1776 |

## Exact source recipes / DOM appendix

Excerpts below are authoritative for classes/conditions. Numbers before `|` are source line numbers, not code. Files prefixed `ui/src/renderer/src/` unless otherwise stated.

### `ui/src/renderer/src/components/ui/AppTitlebar.tsx:1`

```tsx
   1 | import type { MouseEventHandler, ReactNode } from 'react'
   2 | import { MATERIAL_CLS, materialAttrs } from './material'
   3 | 
   4 | /** Leading titlebar slot; the brand lives in the rail header, so this only hosts the show-sidebar control. */
   5 | export function TitlebarLead({ children }: { children?: ReactNode }): React.JSX.Element {
   6 |   return <div className="flex min-w-0 items-center">{children}</div>
   7 | }
   8 | 
   9 | export function AppTitlebar({ children, custom, dataCustom, onMouseDown, onDoubleClick }: {
  10 |   children: ReactNode
  11 |   custom: boolean
  12 |   dataCustom: 'on' | undefined
  13 |   onMouseDown: MouseEventHandler<HTMLElement>
  14 |   onDoubleClick: MouseEventHandler<HTMLElement>
  15 | }): React.JSX.Element {
  16 |   return (
  17 |     <header
  18 |       data-custom={dataCustom}
  19 |       {...materialAttrs('shell')}
  20 |       className={`relative [grid-area:topbar] grid grid-cols-[minmax(0,1fr)_auto] items-center h-[var(--h-top)] [-webkit-app-region:drag] select-none ${MATERIAL_CLS.shell} ${custom ? 'shadow-[var(--glass-topbar-shadow)]' : ''}`}
  21 |       onMouseDown={onMouseDown}
  22 |       onDoubleClick={onDoubleClick}
  23 |     >
  24 |       {children}
  25 |     </header>
  26 |   )
  27 | }
  28 | 
```

### `ui/src/renderer/src/components/ui/NavigationRail.tsx:1`

```tsx
   1 | import { useMascotPrefs } from '../../mascot/mascotPrefs'
   2 | import { MASCOT_FILTERS } from '../../mascot/mascotColors'
   3 | import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
   4 | import type { IconComponent } from '../icons'
   5 | import { IconSearch } from '../icons'
   6 | import { Count } from './Count'
   7 | import { Icon } from './Icon'
   8 | import { HintKey } from './ShortcutHint'
   9 | import { MATERIAL_CLS, materialAttrs } from './material'
  10 | 
  11 | /** The rail column: shell material above the grid, with the glass shadow while Custom paints the field. */
  12 | export function RailSurface({ custom, className = '', children, ...props }: HTMLAttributes<HTMLElement> & { custom: boolean; children: ReactNode }): React.JSX.Element {
  13 |   return (
  14 |     <aside {...props} {...materialAttrs('shell')} className={`w-full flex-none flex flex-col relative z-[var(--z-leaf)] select-none ${MATERIAL_CLS.shell} ${custom ? 'shadow-[var(--glass-rail-shadow)]' : ''} ${className}`}>
  15 |       {children}
  16 |     </aside>
  17 |   )
  18 | }
  19 | 
  20 | export function NavigationRail({ children }: { children: ReactNode }): React.JSX.Element {
  21 |   return <div className="flex-none flex flex-col gap-[var(--space-0-5)] px-[var(--space-2)] pb-[var(--space-1)]">{children}</div>
  22 | }
  23 | 
  24 | /** Without a `logo`, `children` render bare at the leading edge (e.g. a lone sidebar toggle). */
  25 | export function NavigationRailHeader({ logo, children, action, ...props }: HTMLAttributes<HTMLDivElement> & { logo?: { src: string; srcSet: string }; children?: ReactNode; action?: ReactNode }): React.JSX.Element {
  26 |   const prefs = useMascotPrefs()
  27 |   return <div {...props} className="h-[var(--h-railhead)] flex-none flex items-center gap-[var(--space-3)] px-[var(--space-3)] [-webkit-app-region:drag] select-none">{logo ? <><img style={{ filter: MASCOT_FILTERS[prefs.colors] }} data-testid="brand-mark" className="w-[var(--sz-brand-mark)] h-[var(--sz-brand-mark)] flex-none [-webkit-app-region:no-drag]" src={logo.src} srcSet={logo.srcSet} alt="" /><span className="min-w-0 font-semibold [font-size:var(--tr-text-ui-size)] tracking-[var(--tr-text-brand-tracking)] whitespace-nowrap overflow-hidden text-ellipsis [-webkit-app-region:no-drag]">{children}</span></> : children}{action && <div className="ml-auto [-webkit-app-region:no-drag]">{action}</div>}</div>
  28 | }
  29 | 
  30 | export function NavigationRailSection({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  31 |   return <div {...props} className="flex flex-col motion-safe:animate-[rail-slide-in-right_var(--animate-t-panel)_var(--animate-ease-panel)]">{children}</div>
  32 | }
  33 | 
  34 | export function NavigationRailSearch({ paletteChord, onClick }: { paletteChord?: string | null; onClick?: () => void }): React.JSX.Element {
  35 |   return <div className="pb-[var(--space-1-5)]"><button type="button" data-testid="rail-search" className="btn flex h-[var(--h-rail-search)] w-full items-center gap-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-hover-fill px-[var(--space-2)] text-left [font-size:var(--tr-text-small-size)] font-normal text-[var(--text-muted)] hover:bg-hover-fill" onClick={onClick}><Icon glyph={IconSearch} role="small" /><span className="min-w-0 flex-1 truncate">Search</span>{paletteChord && <HintKey size="compact">{paletteChord.replace(/[+\s]/g, '')}</HintKey>}</button></div>
  36 | }
  37 | 
  38 | export function NavigationRailItem({ icon, label, selected = false, trailing, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconComponent; label: string; selected?: boolean; trailing?: ReactNode }): React.JSX.Element {
  39 |   return <button {...props} type="button" aria-current={selected ? 'page' : undefined} className={`btn flex w-full items-center gap-[9px] h-[var(--h-row)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 ${selected ? 'bg-selected-fill text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'} [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-nav-weight)] tracking-[-0.01em] text-left hover:bg-hover-fill hover:text-[var(--text-primary)]`}><span className={`flex flex-none ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}><Icon glyph={icon} role="ui" /></span><span className="min-w-0 truncate">{label}</span>{trailing && <span className="ml-auto">{trailing}</span>}</button>
  40 | }
  41 | 
```

### `ui/src/renderer/src/components/ui/NavigationRailFooter.tsx:1`

```tsx
   1 | import type { HTMLAttributes, ReactNode } from 'react'
   2 | 
   3 | export function NavigationRailFooter({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
   4 |   return <div {...props} className={`railfoot flex-none flex items-center gap-[var(--space-1)] px-[var(--space-2)] pt-[var(--space-1)] pb-[var(--space-1-5)] ${className}`}>{children}</div>
   5 | }
   6 | 
   7 | export function NavigationRailScroll({ children }: { children: ReactNode }): React.JSX.Element {
   8 |   return <div className="railscroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">{children}</div>
   9 | }
  10 | 
  11 | export function WorkspaceList({ children, dragging = false }: { children: ReactNode; dragging?: boolean }): React.JSX.Element {
  12 |   return <nav className={`wlist flex flex-col gap-[var(--space-1)] p-[var(--space-2)] overflow-y-auto ${dragging ? 'cursor-grabbing' : ''}`}>{children}</nav>
  13 | }
  14 | 
  15 | export function SettingsNavigation({ children }: { children: ReactNode }): React.JSX.Element {
  16 |   return <nav className="flex flex-col gap-[var(--space-1)] px-[var(--space-2)] pb-[var(--space-2)]" aria-label="Settings sections">{children}</nav>
  17 | }
```

### `ui/src/renderer/src/components/ui/WorkspaceTreeRow.tsx:1`

```tsx
   1 | import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
   2 | import { Text } from './Text'
   3 | import { Icon } from './Icon'
   4 | import { IconClose, IconGrid } from '../icons'
   5 | 
   6 | export interface WorkspaceTreeRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
   7 |   children: ReactNode
   8 |   kind: 'tree' | 'plain' | 'child' | 'editing'
   9 |   selected?: boolean
  10 |   dragging?: boolean
  11 |   dragged?: boolean
  12 |   className?: string
  13 |   selectionColor?: string
  14 | }
  15 | 
  16 | export function WorkspaceTreeRow({ children, kind, selected = false, dragging = false, dragged = false, className = '', selectionColor, ...props }: WorkspaceTreeRowProps): React.JSX.Element {
  17 |   const tree = kind === 'tree'
  18 |   const classes = kind === 'child'
  19 |     ? 'treerow child relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] pl-[var(--space-6)] pr-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full text-[var(--text-primary)]'
  20 |     : kind === 'editing'
  21 |       ? 'witem relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] py-0 px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 text-[var(--text-primary)] [font-size:var(--tr-text-md)] [font-weight:var(--tr-text-ui-weight)] text-left w-full'
  22 |       : tree
  23 |     ? `witem treerow ws relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill hover:text-[var(--text-primary)] ${selected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`
  24 |     : `witem relative flex items-center gap-[var(--space-2)] h-[var(--h-row)] py-0 px-[var(--space-2)] rounded-[var(--tr-radius-sm)] border-0 text-[length:var(--tr-text-md)] [font-weight:var(--tr-text-ui-weight)] text-left w-full group select-none hover:bg-hover-fill hover:text-[var(--text-primary)] ${selected ? 'bg-selected-fill text-[var(--text-primary)] on' : 'bg-transparent text-[var(--text-secondary)]'}`
  25 |   const cursor = kind === 'child' || kind === 'editing' ? '' : dragging ? 'cursor-grabbing' : 'cursor-pointer'
  26 |   const style = selectionColor
  27 |     ? {
  28 |         ...props.style,
  29 |         '--workspace-selection-outline-color': `color-mix(in srgb, ${selectionColor} var(--workspace-selection-outline-mix), transparent)`,
  30 |         background: `color-mix(in srgb, ${selectionColor} var(--workspace-selection-fill-mix), transparent)`
  31 |       } as CSSProperties
  32 |     : props.style
  33 |   return <div {...props} style={style} className={`${classes} ${cursor} ${selectionColor ? 'ring-1 ring-inset ring-[var(--workspace-selection-outline-color)]' : ''} ${dragged ? 'opacity-[var(--opacity-workspace-row-dragged)]' : ''} ${className}`}>{selectionColor && <span aria-hidden className="absolute left-0 top-[var(--space-1-5)] bottom-[var(--space-1-5)] w-[var(--sz-workspace-selection-rail)] rounded-r-[var(--tr-radius-workspace-selection-rail)]" style={{ background: selectionColor }} />}{children}</div>
  34 | }
  35 | 
  36 | export function WorkspaceTreeLabel({ children, size = 'ui', heading = false }: { children: ReactNode; size?: 'ui' | 'md'; heading?: boolean }): React.JSX.Element {
  37 |   return <Text size={size} weight={heading ? 'semibold' : undefined} tone={heading ? 'secondary' : undefined} className="min-w-0 truncate">{children}</Text>
  38 | }
  39 | 
  40 | export function WorkspaceTreeActions({ children }: { children: ReactNode }): React.JSX.Element {
  41 |   return <span className="ml-auto flex items-center gap-[var(--space-1)] flex-none">{children}</span>
  42 | }
  43 | 
  44 | export function WorkspaceTreeAuxButton({ children, selected = false, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; selected?: boolean }): React.JSX.Element {
  45 |   return <button {...props} type="button" className={`hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center w-[var(--sz-rail-row-action)] h-[var(--sz-rail-row-action)] flex-none rounded-[var(--tr-radius-input)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] ${selected ? 'inline-flex' : ''}`} onClick={onClick}>{children}</button>
  46 | }
  47 | 
  48 | export function WorkspaceDropIndicator(): React.JSX.Element {
  49 |   return <div className="h-0 mx-[var(--space-2)] relative pointer-events-none before:content-[''] before:absolute before:left-0 before:right-0 before:top-[var(--offset-workspace-drop-indicator)] before:h-[var(--h-workspace-drop-indicator)] before:rounded-[var(--tr-radius-workspace-drop-indicator)] before:bg-[var(--accent)]" />
  50 | }
  51 | 
  52 | export function EmptyListMessage({ children, kind = 'workspace' }: { children: ReactNode; kind?: 'workspace' | 'settings' }): React.JSX.Element {
  53 |   return <div className={kind === 'workspace' ? 'px-[var(--space-workspace-empty-list-x)] py-[var(--space-2)]' : 'px-[var(--space-2)] py-[var(--space-2)]'}><Text as="p" flush size="small" weight="small" tone={kind === 'workspace' ? 'faint' : 'muted'} leading="normal">{children}</Text></div>
  54 | }
  55 | 
```

### `ui/src/renderer/src/components/ui/rail/RailChrome.tsx:1`

```tsx
   1 | import { RING_CARD_HOVER_GAP } from '../shadowChrome'
   2 | import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react'
   3 | import { Button } from '../Button'
   4 | import { ContextMenu } from '../ContextMenu'
   5 | import { Icon } from '../Icon'
   6 | import { IconCheck, IconChevronRight, IconPin } from '../../icons'
   7 | import { Tooltip } from '../Tooltip'
   8 | import { WorkspaceTreeRow } from '../WorkspaceTreeRow'
   9 | 
  10 | export function RailOptionsSurface({ children, style }: { children: ReactNode; style: React.CSSProperties }): React.JSX.Element {
  11 |   return <div data-rail-options role="dialog" aria-label="Sidebar options" className="fixed z-[var(--z-popover)] w-[var(--w-rail-options)] rounded-[var(--tr-radius-md)] border border-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] bg-[var(--glass)] p-1 shadow-[var(--shadow-popover)] backdrop-blur-[16px] [backdrop-filter:blur(16px)_saturate(1.08)] [font-size:var(--tr-text-base)]" style={style}>{children}</div>
  12 | }
  13 | 
  14 | export function RailOptionsView({ direction, children }: { direction: 'none' | 'forward' | 'back'; children: ReactNode }): React.JSX.Element {
  15 |   const motion = direction === 'forward' ? 'motion-safe:animate-[rail-options-forward_150ms_ease-out_both]' : direction === 'back' ? 'motion-safe:animate-[rail-options-back_150ms_ease-out_both]' : ''
  16 |   return <div className={motion}>{children}</div>
  17 | }
  18 | 
  19 | export function RailOptionsTitle({ children }: { children: ReactNode }): React.JSX.Element {
  20 |   return <div className="px-2 pt-1.5 pb-1 [font-size:var(--tr-text-xs)] font-medium text-[var(--text-muted)]">{children}</div>
  21 | }
  22 | 
  23 | export function RailOptionsSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  24 |   return <div className="px-2 pt-1.5 pb-1 [font-size:var(--tr-text-xs)] font-medium text-[var(--text-muted)]">{children}</div>
  25 | }
  26 | 
  27 | export function RailOptionsDivider(): React.JSX.Element {
  28 |   return <div className="mx-2 my-1 border-t border-[var(--divider)]" />
  29 | }
  30 | 
  31 | export function RailMenuRow({ children, selected = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }): React.JSX.Element {
  32 |   return <button {...props} type="button" className={`flex min-h-7 w-full items-center gap-2 rounded-[var(--tr-radius-sm)] px-2 py-1 text-left [font-size:var(--tr-text-base)] text-[var(--text-primary)] hover:bg-hover-fill ${selected ? 'bg-hover-fill' : ''}`}>{children}</button>
  33 | }
  34 | 
  35 | export function RailMenuValue({ children }: { children: ReactNode }): React.JSX.Element {
  36 |   return <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{children}</span>
  37 | }
  38 | 
  39 | export function RailMenuCheckSlot({ checked }: { checked: boolean }): React.JSX.Element {
  40 |   return <span className="w-3.5 text-[var(--text-muted)]">{checked && <Icon glyph={IconCheck} role="small" />}</span>
  41 | }
  42 | 
  43 | export function RailCardModeSegment({ value, onChange }: { value: 'detailed' | 'compact'; onChange: (value: 'detailed' | 'compact') => void }): React.JSX.Element {
  44 |   return <div className="px-2 pb-[var(--space-1-5)]"><div className="flex gap-0.5 rounded-[var(--tr-radius-button)] bg-hover-fill p-0.5">
  45 |     {(['detailed', 'compact'] as const).map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className="h-[var(--h-rail-segment)] flex-1 rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-xs)] text-[var(--text-muted)] aria-pressed:bg-[var(--card-hover)] aria-pressed:font-semibold aria-pressed:text-[var(--text-primary)]">{mode === 'compact' ? 'Condensed' : 'Detailed'}</button>)}
  46 |   </div></div>
  47 | }
  48 | 
  49 | export function RailTagDisplaySegment({ value, onChange }: { value: 'icon' | 'dots' | 'chips'; onChange: (value: 'icon' | 'dots' | 'chips') => void }): React.JSX.Element {
  50 |   return <div role="group" aria-label="Tags display" className="mx-2 my-1 flex gap-0.5 rounded-[var(--tr-radius-button)] bg-hover-fill p-0.5">
  51 |     {(['icon', 'dots', 'chips'] as const).map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(mode)} className="h-[var(--h-rail-segment)] flex-1 rounded-[var(--tr-radius-sm)] [font-size:var(--tr-text-xs)] text-[var(--text-muted)] aria-pressed:bg-[var(--card-hover)] aria-pressed:font-semibold aria-pressed:text-[var(--text-primary)]">{mode === 'icon' ? 'Icon' : mode === 'dots' ? 'Dots' : 'Chips'}</button>)}
  52 |   </div>
  53 | }
  54 | 
  55 | export function RailTagFilterValue({ active, colors }: { active: boolean; colors: readonly string[] }): React.JSX.Element {
  56 |   return <span className="ml-auto inline-flex items-center gap-1 text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
  57 |     {active ? <>
  58 |       {colors.length ? colors.map((color, index) => <i key={index} className="size-1.5 rounded-full" style={{ background: color }} />) : 'All'}
  59 |       <Icon glyph={IconChevronRight} role="small" />
  60 |     </> : <span className="inline-flex h-4 items-center rounded-[var(--tr-radius-xs)] border border-[var(--border)] px-1 [font-size:var(--tr-text-xs)]">Off</span>}
  61 |   </span>
  62 | }
  63 | 
  64 | export function RailGroupStatusDot({ label }: { label: string }): React.JSX.Element {
  65 |   const tone = label === 'Needs you' ? 'bg-[var(--warn)]' : label === 'Working' ? 'bg-[var(--info)]' : label === 'Done' ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'
  66 |   return <span aria-hidden className={`size-2 flex-none rounded-full ${tone}`} />
  67 | }
  68 | 
  69 | export function RailGroupSegment({ value, onChange }: { value: 'none' | 'status' | 'workspace' | 'pr'; onChange: (value: 'none' | 'status' | 'workspace' | 'pr') => void }): React.JSX.Element {
  70 |   const options = value === 'pr' ? ['none', 'status', 'workspace', 'pr'] as const : ['none', 'status', 'workspace'] as const
  71 |   return <div className="px-2 pb-[var(--space-1-5)]"><div role="group" aria-label="Group by" className="flex gap-0.5 rounded-[var(--tr-radius-button)] bg-hover-fill p-0.5">
  72 |     {options.map((option) => <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)} className="h-[var(--h-rail-segment)] min-w-0 flex-1 rounded-[var(--tr-radius-sm)] px-0.5 text-[length:var(--tr-text-xs)] text-[var(--text-muted)] aria-pressed:bg-[var(--card-hover)] aria-pressed:font-semibold aria-pressed:text-[var(--text-primary)]">{option === 'none' ? 'None' : option === 'status' ? 'Status' : option === 'pr' ? 'PR' : 'Workspace'}</button>)}
  73 |   </div></div>
  74 | }
  75 | 
  76 | export function RailSortOption({ selected, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean; children: ReactNode }): React.JSX.Element {
  77 |   return <button {...props} type="button" role="radio" aria-checked={selected} className={`flex h-[var(--h-ctl)] items-center gap-[var(--space-2)] rounded-[var(--tr-radius-input)] px-[var(--space-2)] text-left [font-size:var(--tr-text-label-size)] ${selected ? 'bg-selected-fill text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-hover-fill'}`}>{children}</button>
  78 | }
  79 | 
  80 | export function RailSortList({ children }: { children: ReactNode }): React.JSX.Element {
  81 |   return <div role="radiogroup" aria-label="Sort" className="grid gap-[var(--space-0-5)]">{children}</div>
  82 | }
  83 | 
  84 | export function RailSortCheck(): React.JSX.Element {
  85 |   return <Icon glyph={IconCheck} role="small" className="text-[var(--accent)]" />
  86 | }
  87 | 
  88 | export function RailChevron({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  89 |   return <Icon glyph={IconChevronRight} role="small" opacity="subtle" className={`transition-transform duration-150 motion-reduce:transition-none ${collapsed ? '' : 'rotate-90'}`} />
  90 | }
  91 | 
  92 | export function RailOptionsGrid({ children, variant = 'properties' }: { children: ReactNode; variant?: 'properties' | 'always-shown' | 'filters' }): React.JSX.Element {
  93 |   const classes = variant === 'filters' ? 'grid gap-[var(--space-1)] px-[var(--space-2)]' : 'grid grid-cols-2 gap-x-[var(--space-2)] gap-y-[var(--space-1)] px-[var(--space-2)]'
  94 |   return <div style={variant === 'always-shown' ? { paddingBottom: 'var(--space-1)' } : undefined} className={classes}>{children}</div>
  95 | }
  96 | 
  97 | export function RailResetButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  98 |   return <button {...props} type="button" style={{ marginTop: 'var(--space-1)' }} className="px-[var(--space-2)] [font-size:var(--tr-text-label-size)] text-[var(--accent)] hover:underline">{children}</button>
  99 | }
 100 | 
 101 | export function RailOptionsStackGap({ children }: { children: ReactNode }): React.JSX.Element {
 102 |   return <div style={{ marginTop: 'var(--space-2)' }}>{children}</div>
 103 | }
 104 | 
 105 | export function RailFilterValue({ children }: { children: ReactNode }): React.JSX.Element {
 106 |   return <span className="ml-auto">{children}</span>
 107 | }
 108 | 
 109 | export function RailFilterButton({ children, active = true, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }): React.JSX.Element {
 110 |   return <button {...props} type="button" className={`flex h-[var(--h-rail-filter-button)] items-center gap-[var(--space-2)] text-left [font-size:var(--tr-text-label-size)] ${active ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]' : 'text-[var(--text-faint)]'}`}>{children}</button>
 111 | }
 112 | 
 113 | export function RailVirtualViewport({ children, dragging, ...props }: ComponentProps<'div'> & { dragging: boolean; children: ReactNode }): React.JSX.Element {
 114 |   return <div {...props} className={`wlist flex min-h-0 flex-1 flex-col gap-[var(--space-1)] overflow-y-auto px-[var(--space-1-5)] pt-[var(--space-0-5)] pb-[var(--space-2)] ${dragging ? 'cursor-grabbing' : 'cursor-pointer'}`}>{children}</div>
 115 | }
 116 | 
 117 | export function RailWorkspaceGroupRow(props: ComponentProps<typeof WorkspaceTreeRow>): React.JSX.Element {
 118 |   const { className = '', selected = false, ...rest } = props
 119 |   return <WorkspaceTreeRow {...rest} selected={selected} className={`font-semibold ${selected ? 'bg-selected-fill' : ''} ${className}`} />
 120 | }
 121 | 
 122 | export function RailRowCount({ count }: { count: number }): React.JSX.Element {
 123 |   return <span aria-hidden="true" data-count={count} className="flex-none [font-size:var(--tr-text-label-size)] font-medium text-[var(--text-muted)] after:content-[attr(data-count)]" />
 124 | }
 125 | 
 126 | export function RailPinnedIndicator(): React.JSX.Element {
 127 |   return <Tooltip label="Pinned"><span aria-label="Pinned" data-testid="ws-pinned-indicator" className="flex-none flex items-center"><Icon glyph={IconPin} role="small" tone="muted" /></span></Tooltip>
 128 | }
 129 | 
 130 | export function RailUpdateIconButton({ failed = false, ...props }: ComponentProps<typeof Button> & { failed?: boolean }): React.JSX.Element {
 131 |   const { className = '', style, ...rest } = props
 132 |   return <Button {...rest} style={{ ...style, width: 'var(--sz-rail-update-button)', height: 'var(--sz-rail-update-button)', background: 'var(--card-hover)' }} className={`relative ml-auto rounded-full ${failed ? 'text-[var(--warn)]' : 'text-[var(--text-primary)]'} ${className}`} />
 133 | }
 134 | 
 135 | export function RailUpdateDot(): React.JSX.Element {
 136 |   return <span aria-hidden className={`absolute right-[var(--space-1-5)] top-[var(--space-1-5)] size-[var(--space-1-5)] rounded-full bg-current shadow-[${RING_CARD_HOVER_GAP}]`} />
 137 | }
 138 | 
 139 | export function RailSrOnlyText({ children }: { children: ReactNode }): React.JSX.Element {
 140 |   return <span className="sr-only">{children}</span>
 141 | }
 142 | 
 143 | export function RailContextMenu({ visible = true, children, ...props }: ComponentProps<typeof ContextMenu> & { visible?: boolean }): React.JSX.Element {
 144 |   const { className = '', ...rest } = props
 145 |   return <ContextMenu {...rest} className={`${visible ? '' : 'invisible'} ${className}`}>{children}</ContextMenu>
 146 | }
 147 | 
 148 | export function RailGroupHeader({ children }: { children: ReactNode }): React.JSX.Element {
 149 |   // The top padding separates groups; the hover fill covers only the label row.
 150 |   return <div className="group sticky top-0 z-[1] w-full pt-[var(--space-1)]">
 151 |     <div className="flex h-[var(--h-row)] w-full items-center rounded-[var(--tr-radius-sm)] px-2 [font-size:var(--tr-text-small-size)] font-semibold leading-4 text-[var(--text-secondary)] hover:bg-hover-fill">{children}</div>
 152 |   </div>
 153 | }
 154 | 
 155 | export function RailGroupToggle({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
 156 |   return <button {...props} type="button" className="flex h-full min-w-0 flex-1 items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-input)] text-left font-semibold text-[var(--text-secondary)]">{children}</button>
 157 | }
 158 | 
 159 | export function RailGroupCount({ children }: { children: ReactNode }): React.JSX.Element {
 160 |   return <span className="flex-none [font-size:var(--tr-text-label-size)] font-medium text-[var(--text-muted)]">{children}</span>
 161 | }
 162 | 
 163 | export function RailTreeGroupHeader({ children }: { children: ReactNode }): React.JSX.Element {
 164 |   return <div data-testid="tree-group-header" className="box-content flex h-[var(--h-rail-group-header)] flex-none items-center gap-1 px-[var(--space-2)] pt-[var(--space-2)]">{children}</div>
 165 | }
 166 | 
 167 | export function RailTreeTitle({ children }: { children: ReactNode }): React.JSX.Element {
 168 |   return <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-small-size)] leading-4 font-semibold text-[var(--text-muted)]">{children}</span>
 169 | }
 170 | 
 171 | export function RailFilterCountBadge({ children }: { children: ReactNode }): React.JSX.Element {
 172 |   return <span aria-hidden data-testid="tree-filter-badge" className="absolute -right-[var(--space-pixel)] -top-[var(--space-pixel)] h-[var(--h-rail-filter-badge)] min-w-[var(--h-rail-filter-badge)] rounded-full bg-[var(--accent)] px-[var(--space-0-5)] text-center [font-size:var(--tr-text-label-size)] leading-[var(--h-rail-filter-badge)] text-white">{children}</span>
 173 | }
 174 | 
```

### `ui/src/renderer/src/components/ui/rail/GridRailRowView.tsx:1`

```tsx
   1 | import type { RailCard } from '../../rail/railCardModel'
   2 | import type { RailAgentRow } from '../../rail/railCardModel'
   3 | import type { TagInfo } from '../../../houston/generated/TagInfo'
   4 | import type { PrInfo } from '../../../houston/client'
   5 | import type { AgentActivityMode, RailCardMode, RailCardProperty, RailTagDisplay } from '../../../railPrefs'
   6 | import { isRailCardQuiet } from '../../rail/railCardModel'
   7 | import { Tooltip } from '../Tooltip'
   8 | import { GridRailTitleRow } from './GridRailTitleRow'
   9 | import { GridRailCheckoutLine } from './GridRailCheckoutLine'
  10 | import { GridRailAgentRows } from './GridRailAgentRows'
  11 | import { GridRailHoverCardHost } from './GridRailHoverCardHost'
  12 | import { TagCardAffordance } from '../../tags/TagCardAffordance'
  13 | 
  14 | function statusDotClass(kind: RailCard['status']['kind']): string {
  15 |   if (kind === 'needs-input') return 'bg-[var(--warn)]'
  16 |   if (kind === 'working') return 'animate-[spin_1s_linear_infinite] motion-reduce:animate-none border-[1.5px] border-[var(--accent)] border-r-transparent bg-transparent'
  17 |   if (kind === 'starting') return 'bg-[var(--accent)]'
  18 |   if (kind === 'exited') return 'bg-[var(--stop)]'
  19 |   if (kind === 'done') return 'bg-[var(--ok)]'
  20 |   return 'bg-[var(--text-faint)]'
  21 | }
  22 | 
  23 | function StatusDot({ card, now }: { card: RailCard; now: number }): React.JSX.Element {
  24 |   const quiet = isRailCardQuiet(card.status, now)
  25 |   const state = card.status.kind === 'exited' ? 'stopped' : card.status.kind
  26 |   return quiet ? (
  27 |     <Tooltip label="No recent update from agent">
  28 |     <span data-testid="grid-state-dot" data-state={state} role="img" aria-label="No recent update from agent" className="inline-block size-1.5 flex-none rounded-full border border-[var(--info)] bg-transparent" />
  29 |     </Tooltip>
  30 |   ) : (
  31 |     <span data-testid="grid-state-dot" data-state={state} role="img" className={`inline-block ${card.status.kind === 'working' ? 'size-[9px]' : 'size-2'} flex-none rounded-full ${statusDotClass(card.status.kind)}`} aria-label={state === 'unavailable' ? 'Grid status unavailable' : card.status.label} />
  32 |   )
  33 | }
  34 | 
  35 | function gridRowClassName({ cardMode, hasChipRow, dragging, dragPosition, selected }: {
  36 |   cardMode: RailCardMode
  37 |   hasChipRow: boolean
  38 |   dragging: boolean
  39 |   dragPosition: 'before' | 'after' | null
  40 |   selected: boolean
  41 | }): string {
  42 |   return `rail-grid-row group relative min-w-0 rounded-[var(--tr-radius-button)] border border-transparent pr-1.5
  43 |     transition-[background-color,border-color] duration-150 ${selected ? 'hover:bg-selected-fill' : 'hover:bg-hover-fill'}
  44 |     ${cardMode === 'compact' ? hasChipRow ? 'flex min-h-8 items-start gap-1.5 pl-1 py-1' : 'flex h-8 items-center gap-1.5 pl-1 py-1' : 'flex gap-1.5 pl-1 pt-1.5 pb-[7px]'}
  45 |     ${dragging ? 'opacity-50' : ''}
  46 |     ${dragPosition ? `after:absolute after:left-1 after:right-1 after:h-px after:bg-[var(--accent)] ${dragPosition === 'before' ? 'after:top-0' : 'after:bottom-0'}` : ''}
  47 |     ${selected ? 'border-[var(--border)] bg-selected-fill text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'}`
  48 | }
  49 | 
  50 | export function GridRailRowView({
  51 |   name, workspace, gridId, selected, pinned, tags,
  52 |   cardMode, tagDisplay, agentActivity, properties, dragPosition, dragging, dragRefusal, onGridPointerDown,
  53 |   onToggleUnread, onFilterTag, jumpNumber, onRemove, onSelect, onContextMenu, onOpenInspector, card, primary,
  54 |   checkoutLabel, many, hasUnread, altHeld, hoverPosition, hoverVisible, expanded, now, rowRef, closeTimer,
  55 |   openTagPopover, startHover, closeHover, onToggleExpanded, onKeyDown,
  56 | }: {
  57 |   name: string
  58 |   workspace: string
  59 |   gridId: string
  60 |   selected: boolean
  61 |   pinned: boolean
  62 |   tags: readonly TagInfo[]
  63 |   cardMode: RailCardMode
  64 |   tagDisplay: RailTagDisplay
  65 |   agentActivity: AgentActivityMode
  66 |   properties: readonly RailCardProperty[]
  67 |   dragPosition: 'before' | 'after' | null
  68 |   dragging: boolean
  69 |   dragRefusal: boolean
  70 |   onGridPointerDown?: (event: React.PointerEvent, workspace: string, gridId: string) => void
  71 |   onToggleUnread?: () => void
  72 |   onFilterTag?: (tag: TagInfo) => void
  73 |   jumpNumber?: number
  74 |   onRemove?: () => void
  75 |   onSelect: () => void
  76 |   onContextMenu?: (event: React.MouseEvent) => void
  77 |   onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
  78 |   card: RailCard
  79 |   primary?: RailAgentRow
  80 |   checkoutLabel: { branch: string | null; text: string } | null
  81 |   many: boolean
  82 |   hasUnread: boolean
  83 |   altHeld: boolean
  84 |   hoverPosition: { left: number; top: number } | null
  85 |   hoverVisible: boolean
  86 |   expanded: boolean
  87 |   now: number
  88 |   rowRef: React.RefObject<HTMLDivElement | null>
  89 |   closeTimer: React.RefObject<ReturnType<typeof setTimeout> | null>
  90 |   openTagPopover: (options: import('../../tags/TagPopover').OpenTagPopoverOptions) => void
  91 |   startHover: () => void
  92 |   closeHover: () => void
  93 |   onToggleExpanded: () => void
  94 |   onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  95 | }): React.JSX.Element {
  96 |   const pr = card.pr?.pr ?? null
  97 |   const hasChipRow = properties.includes('tags') && tagDisplay === 'chips' && tags.length > 0
  98 |   const openTags = (anchor: HTMLElement): void => openTagPopover({ anchor, gridId, view: 'pick' })
  99 |   return (
 100 |     <Tooltip label={dragRefusal ? 'Grids can only be reordered within the same workspace' : null} className="block">
 101 |       <div
 102 |         ref={rowRef}
 103 |         role="button"
 104 |         tabIndex={0}
 105 |         data-testid="grid-row"
 106 |         data-grid-id={gridId}
 107 |         data-rail-grid-id={gridId}
 108 |         data-rail-workspace={workspace}
 109 |         data-drag-position={dragPosition ?? undefined}
 110 |         data-selected={selected ? 'true' : undefined}
 111 |         data-card-mode={cardMode}
 112 |         aria-current={selected ? 'true' : undefined}
 113 |         aria-label={`${name}, ${card.status.label}`}
 114 |         className={gridRowClassName({ cardMode, hasChipRow, dragging, dragPosition, selected })}
 115 |         onPointerDown={(event) => onGridPointerDown?.(event, workspace, gridId)}
 116 |         onClick={onSelect}
 117 |         onKeyDown={onKeyDown}
 118 |         onContextMenu={onContextMenu}
 119 |         onMouseEnter={startHover}
 120 |         onMouseLeave={closeHover}
 121 |       >
 122 |         <GridRailUnreadToggle card={card} now={now} cardMode={cardMode} hasUnread={hasUnread} onToggleUnread={onToggleUnread} />
 123 |         <div className={`flex min-w-0 flex-1 flex-col ${cardMode === 'compact' && !hasChipRow ? 'justify-center' : 'gap-[5px]'}`}>
 124 |           <GridRailTitleRow name={name} unread={properties.includes('unread') && hasUnread} pinned={pinned} tags={tags} hasTags={properties.includes('tags')} tagDisplay={tagDisplay} pr={pr} hasPr={properties.includes('pr')} hasCheckout={properties.includes('checkout')} cardMode={cardMode} checkoutLabel={checkoutLabel} many={many} agentCount={card.agents.length} primary={primary} hasRemove={Boolean(onRemove)} gridId={gridId} onRemove={onRemove} onOpenInspector={onOpenInspector} openTagPopover={openTagPopover} />
 125 |           <GridRailCheckout cardMode={cardMode} hasCheckout={properties.includes('checkout')} label={checkoutLabel} pr={pr} hasPr={properties.includes('pr')} hasDiff={properties.includes('diff')} diff={card.diff} primary={primary} onOpenInspector={onOpenInspector} />
 126 |           {hasChipRow && <div className="flex min-h-4 items-center text-[length:var(--tr-text-xs)]"><TagCardAffordance tags={tags} mode="chips" onClick={openTags} onFilter={onFilterTag} /></div>}
 127 |           <GridRailAgentRows agents={card.agents} cardMode={cardMode} agentActivity={agentActivity} properties={properties} expanded={expanded} onToggleExpanded={onToggleExpanded} now={now} />
 128 |         </div>
 129 |         <GridRailJumpNumber number={jumpNumber} altHeld={altHeld} />
 130 |       </div>
 131 |       {hoverPosition && <GridRailHoverCardHost card={card} tags={tags} position={hoverPosition} visible={hoverVisible} closeTimer={closeTimer} scheduleClose={closeHover} onOpenInspector={onOpenInspector} />}
 132 |     </Tooltip>
 133 |   )
 134 | }
 135 | 
 136 | function GridRailUnreadToggle({ card, now, cardMode, hasUnread, onToggleUnread }: {
 137 |   card: RailCard
 138 |   now: number
 139 |   cardMode: RailCardMode
 140 |   hasUnread: boolean
 141 |   onToggleUnread?: () => void
 142 | }): React.JSX.Element {
 143 |   const label = hasUnread ? 'Mark as read' : 'Mark as unread'
 144 |   return <Tooltip label={label}>
 145 |     <button type="button" aria-label={label} data-testid="grid-unread-toggle" className={`relative flex w-4 flex-none justify-center ${cardMode === 'compact' ? 'items-start pt-1' : 'h-5 items-start pt-[5px]'}`} onClick={(event) => { event.stopPropagation(); onToggleUnread?.() }}>
 146 |       <StatusDot card={card} now={now} />
 147 |     </button>
 148 |   </Tooltip>
 149 | }
 150 | 
 151 | function GridRailCheckout({ cardMode, hasCheckout, label, pr, hasPr, hasDiff, diff, primary, onOpenInspector }: {
 152 |   cardMode: RailCardMode
 153 |   hasCheckout: boolean
 154 |   label: { branch: string | null; text: string } | null
 155 |   pr: PrInfo | null
 156 |   hasPr: boolean
 157 |   hasDiff: boolean
 158 |   diff: RailCard['diff']
 159 |   primary?: RailAgentRow
 160 |   onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
 161 | }): React.JSX.Element | null {
 162 |   if (cardMode !== 'detailed' || !hasCheckout || !label) return null
 163 |   return <GridRailCheckoutLine label={label} pr={hasPr ? pr : null} diff={hasDiff ? diff : null} onOpenInspector={() => primary && onOpenInspector(primary.session.id, 'pull-request')} />
 164 | }
 165 | 
 166 | function GridRailJumpNumber({ number, altHeld }: { number?: number; altHeld: boolean }): React.JSX.Element | null {
 167 |   if (number == null) return null
 168 |   return <span aria-hidden data-testid="rail-jump-number" className={`rail-jump absolute left-1 top-1/2 -translate-y-1/2 font-mono text-[var(--accent)] ${altHeld ? '' : 'hidden'}`}>{number}</span>
 169 | }
```

### `ui/src/renderer/src/components/ui/rail/GridRailTitleRow.tsx:1`

```tsx
   1 | import type { RailAgentRow } from '../../rail/railCardModel'
   2 | import type { PrInfo } from '../../../houston/client'
   3 | import type { TagInfo } from '../../../houston/generated/TagInfo'
   4 | import type { RailCardMode, RailTagDisplay } from '../../../railPrefs'
   5 | import type { OpenTagPopoverOptions } from '../../tags/TagPopover'
   6 | import { TagCardAffordance } from '../../tags/TagCardAffordance'
   7 | import { Icon } from '../Icon'
   8 | import { IconClose, IconTag, IconGitPullRequest } from '../../icons'
   9 | import { PrLink } from '../PrLink'
  10 | import { Tooltip } from '../Tooltip'
  11 | 
  12 | export function GridRailTitleRow({
  13 |   name,
  14 |   unread = false,
  15 |   tags,
  16 |   hasTags,
  17 |   tagDisplay,
  18 |   pr,
  19 |   hasPr,
  20 |   hasCheckout,
  21 |   cardMode,
  22 |   checkoutLabel,
  23 |   primary,
  24 |   hasRemove,
  25 |   gridId,
  26 |   onRemove,
  27 |   onOpenInspector,
  28 |   openTagPopover,
  29 | }: {
  30 |   name: string
  31 |   // Unread is carried by the title, so the status column keeps a single dot and amber stays reserved for needs-input.
  32 |   unread?: boolean
  33 |   pinned: boolean
  34 |   tags: readonly TagInfo[]
  35 |   hasTags: boolean
  36 |   tagDisplay: RailTagDisplay
  37 |   pr: PrInfo | null
  38 |   hasPr: boolean
  39 |   hasCheckout: boolean
  40 |   cardMode: RailCardMode
  41 |   checkoutLabel: { branch: string | null; text: string } | null
  42 |   many: boolean
  43 |   agentCount: number
  44 |   primary?: RailAgentRow
  45 |   hasRemove: boolean
  46 |   gridId: string
  47 |   onRemove?: () => void
  48 |   onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
  49 |   openTagPopover: (options: OpenTagPopoverOptions) => void
  50 | }): React.JSX.Element {
  51 |   const tagNames = tags.map((tag) => tag.name)
  52 |   return (
  53 |     <div className="flex h-5 min-w-0 items-center gap-1.5 text-[length:var(--tr-text-base)] leading-5">
  54 |       <span data-testid="grid-name" className={`min-w-0 truncate ${unread ? 'font-semibold text-[var(--text-primary)]' : ''}`}>{name}</span>
  55 |       {unread && <span role="img" aria-label="Unread" data-testid="grid-unread-pip" className="size-1.5 flex-none rounded-full bg-[var(--accent)]" />}
  56 |       <span aria-hidden className="min-w-0 flex-1" />
  57 |       {pr?.is_draft && <span className="flex-none rounded border border-[var(--border)] px-1 text-[length:var(--tr-text-xs)] leading-4 text-[var(--text-muted)]">draft</span>}
  58 |       {hasTags && tagDisplay === 'dots' && <TagCardAffordance tags={tags} mode="dots" onClick={(anchor) => openTagPopover({ anchor, gridId, view: 'pick' })} />}
  59 |       {hasTags && tagDisplay === 'icon' && tags.length > 0 && (
  60 |         <Tooltip label={`Edit tags: ${tagNames.join(' · ')}`}>
  61 |           <button
  62 |             type="button"
  63 |             aria-label={`Edit tags: ${tagNames.join(', ')}`}
  64 |             data-testid="rail-tags"
  65 |             className="inline-flex flex-none items-center gap-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
  66 |             onClick={(event) => {
  67 |               event.stopPropagation()
  68 |               openTagPopover({ anchor: event.currentTarget, gridId, view: 'pick' })
  69 |             }}
  70 |           >
  71 |             <span data-testid="rail-tag-glyph" style={{ color: tags[0].color }}><Icon glyph={IconTag} role="small" /></span>
  72 |             {tags.length > 1 && <span className="text-[length:var(--tr-text-xs)]">+{tags.length - 1}</span>}
  73 |           </button>
  74 |         </Tooltip>
  75 |       )}
  76 |       {cardMode === 'compact' && hasPr && pr && (
  77 |         <PrLink
  78 |           href={pr.url}
  79 |           onClick={() => primary && onOpenInspector(primary.session.id, 'pull-request')}
  80 |           className="flex-none font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]"
  81 |         >
  82 |           <Icon glyph={IconGitPullRequest} role="small" />#{pr.number}
  83 |         </PrLink>
  84 |       )}
  85 |       {cardMode === 'compact' && hasCheckout && checkoutLabel?.branch && (
  86 |         <Tooltip label={checkoutLabel.text}>
  87 |           <span className="max-w-24 truncate font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{checkoutLabel.branch}</span>
  88 |         </Tooltip>
  89 |       )}
  90 |       {hasRemove && (
  91 |         <Tooltip label={`Remove ${name}`}>
  92 |         <button
  93 |           type="button"
  94 |           data-testid="grid-close"
  95 |           aria-label={`Remove ${name}`}
  96 |           className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] group-hover:flex"
  97 |           onClick={(event) => {
  98 |             event.stopPropagation()
  99 |             onRemove?.()
 100 |           }}
 101 |         >
 102 |           <Icon glyph={IconClose} role="small" />
 103 |         </button>
 104 |         </Tooltip>
 105 |       )}
 106 |     </div>
 107 |   )
 108 | }
```

### `ui/src/renderer/src/components/ui/rail/GridRailCheckoutLine.tsx:1`

```tsx
   1 | import { Icon } from '../Icon'
   2 | import { IconGitBranch, IconGitPullRequest } from '../../icons'
   3 | import { Tooltip } from '../Tooltip'
   4 | import { PrLink } from '../PrLink'
   5 | 
   6 | export function GridRailCheckoutLine({
   7 |   label,
   8 |   pr,
   9 |   diff,
  10 |   onOpenInspector,
  11 | }: {
  12 |   label: { branch: string | null; text: string }
  13 |   pr: { url: string; number: number; state: string; is_draft: boolean; checks: string } | null
  14 |   diff: { added: number; deleted: number } | null
  15 |   onOpenInspector: () => void
  16 | }): React.JSX.Element {
  17 |   return (
  18 |     <div className="flex h-4 min-w-0 items-center gap-1 font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">
  19 |       <Icon glyph={IconGitBranch} role="small" className="flex-none" />
  20 |       <Tooltip label={label.text}>
  21 |         <span className="min-w-0 truncate">{label.text}</span>
  22 |       </Tooltip>
  23 |       <span className="ml-auto flex flex-none items-center gap-1.5">
  24 |         {pr && <Tooltip label={`#${pr.number}`}><PrLink href={pr.url} onClick={onOpenInspector} aria-label={`Open pull request #${pr.number}${pr.checks ? `, checks ${pr.checks}` : ''}`} style={{ color: `var(--${pr.is_draft ? 'text-muted' : pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'text-muted' : pr.checks === 'failing' ? 'stop' : pr.checks === 'passing' ? 'ok' : 'warn'})` }}>
  25 |           <Icon glyph={IconGitPullRequest} role="small" />
  26 |           {pr.checks && <span className="sr-only">{pr.checks}</span>}
  27 |         </PrLink></Tooltip>}
  28 |         {diff && <span className="inline-flex gap-1 font-mono"><span className="text-[var(--ok)]">+{diff.added}</span><span className="text-[var(--stop)]">-{diff.deleted}</span></span>}
  29 |       </span>
  30 |     </div>
  31 |   )
  32 | }
```

### `ui/src/renderer/src/components/ui/rail/GridRailAgentRows.tsx:1`

```tsx
   1 | import type { SessionInfo } from '../../../houston/client'
   2 | import type { RailAgentRow } from '../../rail/railCardModel'
   3 | import type { AgentActivityMode, RailCardMode, RailCardProperty } from '../../../railPrefs'
   4 | import { AgentSummaryPill } from '../AgentSummaryPill'
   5 | import { IconAgent } from '../../icons'
   6 | import { Tooltip } from '../Tooltip'
   7 | 
   8 | function AgentStatusDot({ session, now }: { session: SessionInfo; now: number }): React.JSX.Element {
   9 |   const quiet = session.status === 'working' && session.status_since_ms != null && now - session.status_since_ms >= 10 * 60_000
  10 |   return quiet ? (
  11 |     <Tooltip label={`No recent update from ${session.agent}`}>
  12 |       <span aria-label={`No recent update from ${session.agent}`} className="inline-block size-2 flex-none rounded-full border border-[var(--info)] bg-transparent" />
  13 |     </Tooltip>
  14 |   ) : (
  15 |     <span aria-hidden data-testid="agent-row-dot" className={`inline-block ${session.status === 'working' ? 'size-[9px]' : 'size-2'} flex-none rounded-full ${agentRowDotClass(session.status)}`} />
  16 |   )
  17 | }
  18 | 
  19 | function agentRowDotClass(status: SessionInfo['status']): string {
  20 |   switch (status) {
  21 |     case 'needs-input':
  22 |       return 'bg-[var(--warn)]'
  23 |     case 'working':
  24 |       return 'animate-[spin_1s_linear_infinite] motion-reduce:animate-none border-[1.5px] border-[var(--accent)] border-r-transparent bg-transparent'
  25 |     case 'spawning':
  26 |       return 'bg-[var(--accent)]'
  27 |     case 'idle':
  28 |       return 'bg-[var(--text-faint)] opacity-60'
  29 |     default:
  30 |       return 'border-[1.5px] border-[var(--text-secondary)] bg-transparent'
  31 |   }
  32 | }
  33 | 
  34 | function ageLabel(session: SessionInfo, now: number): string {
  35 |   if (session.status === 'working') return 'now'
  36 |   const elapsed = Math.max(0, now - (session.status_since_ms ?? now))
  37 |   const minutes = Math.floor(elapsed / 60_000)
  38 |   if (minutes < 1) return 'now'
  39 |   if (minutes < 60) return `${minutes}m`
  40 |   const hours = Math.floor(minutes / 60)
  41 |   return `${hours}h`
  42 | }
  43 | 
  44 | function AgentRow({ agent, now }: { agent: RailAgentRow; now: number }): React.JSX.Element {
  45 |   const shellLabel = agent.session.agent === 'shell' ? ` · ${agent.agent}` : ''
  46 |   return (
  47 |     <div key={agent.session.id} className="flex h-[var(--h-agent-row)] min-w-0 items-center gap-[5px] rounded px-1 text-[length:var(--tr-text-xs)] leading-none hover:bg-hover-fill">
  48 |       <AgentStatusDot session={agent.session} now={now} />
  49 |       <span className="flex flex-none text-[var(--text-muted)]"><IconAgent agent={agent.agent} role="small" brand /></span>
  50 |       <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
  51 |         {agent.leading}{shellLabel}
  52 |       </span>
  53 |       {agent.model && <span className="max-w-[76px] truncate font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{agent.model}</span>}
  54 |       <time className="min-w-[22px] flex-none text-right text-[length:var(--tr-text-xs)] tabular-nums text-[var(--text-muted)]">{ageLabel(agent.session, now)}</time>
  55 |     </div>
  56 |   )
  57 | }
  58 | 
  59 | export function GridRailAgentRows({
  60 |   agents,
  61 |   cardMode,
  62 |   agentActivity,
  63 |   properties,
  64 |   expanded,
  65 |   onToggleExpanded,
  66 |   now,
  67 | }: {
  68 |   agents: RailAgentRow[]
  69 |   cardMode: RailCardMode
  70 |   agentActivity: AgentActivityMode
  71 |   properties: readonly RailCardProperty[]
  72 |   expanded: boolean
  73 |   onToggleExpanded: () => void
  74 |   now: number
  75 | }): React.JSX.Element | null {
  76 |   if (cardMode !== 'detailed') return null
  77 |   const many = agents.length > 2
  78 |   const showFullList = agentActivity === 'full' || expanded
  79 |   return (
  80 |     <>
  81 |       {many && properties.includes('inline-agents') && (
  82 |         <div>
  83 |           <AgentSummaryPill agents={agents} expanded={expanded} onToggle={onToggleExpanded} />
  84 |         </div>
  85 |       )}
  86 |       {many ? (
  87 |         <div aria-hidden={!showFullList} className={`grid overflow-hidden transition-[grid-template-rows] duration-[180ms] ease-out motion-reduce:transition-none ${showFullList ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
  88 |           <div className="min-h-0 overflow-hidden">
  89 |             {agents.map((agent) => <AgentRow key={agent.session.id} agent={agent} now={now} />)}
  90 |           </div>
  91 |         </div>
  92 |       ) : agents.map((agent) => <AgentRow key={agent.session.id} agent={agent} now={now} />)}
  93 |     </>
  94 |   )
  95 | }
```

### `ui/src/renderer/src/components/ui/AgentSummaryPill.tsx:1`

```tsx
   1 | import { Icon } from './Icon'
   2 | import { IconChevronRight } from '../icons'
   3 | import type { RailAgentRow } from '../rail/railCardModel'
   4 | import { IconAgent } from '../icons'
   5 | 
   6 | const STATUS_ORDER = ['needs-input', 'working', 'idle', 'starting', 'unavailable', 'done'] as const
   7 | 
   8 | export function AgentSummaryPill({
   9 |   agents,
  10 |   expanded,
  11 |   onToggle,
  12 | }: {
  13 |   agents: readonly RailAgentRow[]
  14 |   expanded: boolean
  15 |   onToggle: () => void
  16 | }): React.JSX.Element {
  17 |   const groups = STATUS_ORDER.flatMap((status) => {
  18 |     const rows = agents.filter(
  19 |       ({ session }) => session.status === status || (status === 'needs-input' && session.children_waiting > 0),
  20 |     )
  21 |     return rows.length ? [{ status, rows }] : []
  22 |   })
  23 |   const ungrouped = agents.filter(
  24 |     ({ session }) => !STATUS_ORDER.includes((session.status ?? 'idle') as (typeof STATUS_ORDER)[number]),
  25 |   )
  26 |   if (ungrouped.length) groups.push({ status: 'idle', rows: ungrouped })
  27 |   return (
  28 |     <button
  29 |       type="button"
  30 |       aria-expanded={expanded}
  31 |       onClick={onToggle}
  32 |       className="flex h-6 w-full min-w-0 items-center gap-[5px] rounded-[var(--tr-radius-xs)] border border-[var(--divider)] bg-hover-fill px-1
  33 |         text-[length:var(--tr-text-xs)] text-[var(--text-muted)] hover:bg-[var(--card-hover)]"
  34 |     >
  35 |       <span className="shrink-0">
  36 |         {expanded ? `${agents.length} agents` : `${agents.length} agents`}
  37 |       </span>
  38 |       {!expanded && (
  39 |         <span className="flex min-w-0 items-center gap-1 overflow-hidden">
  40 |           {groups.slice(0, 3).map(({ status, rows }) => (
  41 |             <span
  42 |               key={status}
  43 |               data-state={status}
  44 |               aria-label={`${rows.length} ${status} agents`}
  45 |               className="inline-flex items-center gap-[3px] rounded bg-[var(--rail-bg)] px-1 text-[var(--text-secondary)]"
  46 |             >
  47 |               <i
  48 |                 className={`size-[9px] rounded-full ${status === 'working' ? 'animate-[spin_1s_linear_infinite] motion-reduce:animate-none border-[1.5px] border-[var(--accent)] border-r-transparent bg-transparent' : ''} ${
  49 |                   status === 'working'
  50 |                     ? ''
  51 |                     : status === 'needs-input'
  52 |                       ? 'bg-[var(--warn)]'
  53 |                       : 'bg-[var(--text-faint)]'
  54 |                 }`}
  55 |               />
  56 |               <span className="inline-flex items-center pl-0.5">
  57 |                 {rows.slice(0, 2).map(({ session, agent }, index) => <span key={session.id} className={`-ml-0.5 inline-flex size-3.5 items-center justify-center rounded-full border border-[var(--rail-bg)] bg-[var(--card-hover)] ${index === 0 ? 'ml-0' : ''}`}><IconAgent agent={agent} role="small" brand /></span>)}
  58 |               </span>
  59 |               {rows.length > 2 && <span>+{rows.length - 2}</span>}
  60 |             </span>
  61 |           ))}
  62 |         </span>
  63 |       )}
  64 |       <Icon
  65 |         glyph={IconChevronRight}
  66 |         role="small"
  67 |         className={`ml-auto flex-none transition-transform duration-[180ms] motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
  68 |       />
  69 |     </button>
  70 |   )
  71 | }
  72 | 
```

### `ui/src/renderer/src/components/ui/PaneControls.tsx:1`

```tsx
   1 | import { useContext, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
   2 | import type { AgentStatus } from '../../houston/client'
   3 | import { Text } from './Text'
   4 | import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
   5 | import { BTN_ICO_STRUCTURE } from './buttonChrome'
   6 | import { RING_ACCENT_ICON } from './shadowChrome'
   7 | import { HIT_TARGET_28 } from '../hitTarget'
   8 | import { Tooltip, TooltipContext } from './Tooltip'
   9 | 
  10 | export function PaneHeadActions({ children }: { children: ReactNode }): React.JSX.Element {
  11 |   return <span className="head-actions ml-auto flex items-center gap-px flex-none">{children}</span>
  12 | }
  13 | 
  14 | const HEAD_BUTTON_STYLE =
  15 |   `rounded-[var(--tr-radius-sm)] [transition:background-color_0.15s,color_0.15s] active:scale-[0.97] focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none`
  16 | const HEAD_BUTTON_SIZE = {
  17 |   default: CONTROL_SIZE_SQUARE_CLS.mini,
  18 |   small: CONTROL_SIZE_SQUARE_CLS.small,
  19 |   tabClose: 'w-[16px] h-[16px]',
  20 |   tabOverflow: `btn ${CONTROL_SIZE_SQUARE_CLS.small} ${CONTROL_SIZE_SQUARE_CLS.mini} border-l border-[color-mix(in_srgb,var(--divider)_55%,transparent)]`
  21 | } as const
  22 | /** Session headers shrink their buttons in narrow panes and dim them while a sibling pane holds focus. */
  23 | const HEAD_BUTTON_LADDER =
  24 |   '[@container_(max-width:280px)]:w-[var(--h-pane-icon-button-compact)] [@container_(max-width:280px)]:h-[var(--h-pane-icon-button-compact)] [@container_(max-width:200px)]:w-[var(--h-pane-icon-button-narrow)] [@container_(max-width:200px)]:h-[var(--h-pane-icon-button-narrow)] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))]'
  25 | 
  26 | const HEAD_BUTTON_TONE = {
  27 |   neutral:
  28 |     'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)]',
  29 |   regular:
  30 |     'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]',
  31 |   accent:
  32 |     'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]',
  33 |   danger:
  34 |     'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]',
  35 |   info: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'
  36 | } as const
  37 | 
  38 | export type PaneHeadButtonTone = keyof typeof HEAD_BUTTON_TONE
  39 | 
  40 | export function PaneHeadIdentity({ children }: { children: ReactNode }): React.JSX.Element {
  41 |   return <span data-testid="head-identity" className="head-identity inline-flex items-center gap-[var(--space-2)] min-w-0 overflow-hidden [flex:0_1_auto]">{children}</span>
  42 | }
  43 | 
  44 | export function PaneNotice({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  45 |   return (
  46 |     <Text as="div" {...rest} size="small" weight="small" tone="muted" className="flex items-center gap-[var(--space-2)] flex-none py-[var(--space-pane-notice-block)] px-[var(--space-2)] border-b border-[var(--border)]">
  47 |       {children}
  48 |     </Text>
  49 |   )
  50 | }
  51 | 
  52 | /** An icon button in a pane header. `className` carries layout only (for example a container-query cut). */
  53 | export function PaneHeadButton({
  54 |   tone = 'regular',
  55 |   ladder = true,
  56 |   size = 'default',
  57 |   className = '',
  58 |   ...rest
  59 | }: { tone?: PaneHeadButtonTone; ladder?: boolean; size?: keyof typeof HEAD_BUTTON_SIZE } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  60 |   const target = size === 'tabClose' || size === 'tabOverflow' ? HIT_TARGET_28 : ''
  61 |   const buttonClass = size === 'tabClose' ? 'btn' : ''
  62 |   const button = <button {...rest} className={`${buttonClass} ${BTN_ICO_STRUCTURE} ${HEAD_BUTTON_SIZE[size]} ${target} ${HEAD_BUTTON_STYLE} ${ladder ? HEAD_BUTTON_LADDER : ''} ${HEAD_BUTTON_TONE[tone]} ${className}`.trim()} />
  63 |   const parentTooltip = useContext(TooltipContext)
  64 |   const label = rest['aria-label']
  65 |   return label && !parentTooltip ? <Tooltip label={label}>{button}</Tooltip> : button
  66 | }
  67 | 
  68 | /** A label-sized note in a session header, such as the protocol mode or account profile. */
  69 | export function PaneHeadBadge(props: Omit<HTMLAttributes<HTMLSpanElement>, 'className'>): React.JSX.Element {
  70 |   return <span {...props} className="inline-flex items-center text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] flex-none whitespace-nowrap cursor-default" />
  71 | }
  72 | 
  73 | const STATUS_PULSE = 'loop-anim [--dot-pulse-opacity:0.35] motion-safe:animate-[dot-pulse_1.4s_steps(4,end)_infinite]'
  74 | 
  75 | function statusDotClass(status: AgentStatus): string {
  76 |   switch (status) {
  77 |     case 'working':
  78 |       return `bg-[var(--info)] ${STATUS_PULSE}`
  79 |     case 'spawning':
  80 |       return `bg-[var(--accent)] ${STATUS_PULSE}`
  81 |     case 'idle':
  82 |       return 'bg-[var(--text-muted)]'
  83 |     case 'needs-input':
  84 |       return 'bg-[var(--warn)]'
  85 |     case 'unavailable':
  86 |       // A border, not a ring: hosts such as the roster strip give .agent-dot a box-shadow halo, which would replace a ring.
  87 |       return 'bg-[var(--card-bg)] border-[1.5px] border-[var(--text-secondary)]'
  88 |   }
  89 | }
  90 | 
  91 | /** The 7px agent status dot; only the two indeterminate states pulse. */
  92 | export function PaneStatusDot({ status, ...rest }: { status: AgentStatus } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  93 |   return <span {...rest} className={`agent-dot w-[var(--sz-pane-status-dot)] h-[var(--sz-pane-status-dot)] rounded-full flex-none ${statusDotClass(status)}`} />
  94 | }
  95 | 
  96 | export function PaneEngineGlyph({ className = '', ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  97 |   return <span {...rest} className={`${className} inline-flex items-center justify-center w-4 h-4 flex-none`.trim()} />
  98 | }
  99 | 
 100 | export function PaneSubtitle({ className = '', ...rest }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
 101 |   return (
 102 |     <Text
 103 |       as="span"
 104 |       {...rest}
 105 |       size="xs"
 106 |       tone="faint"
 107 |       className={`${className} whitespace-nowrap overflow-hidden text-ellipsis min-w-0`.trim()}
 108 |     />
 109 |   )
 110 | }
 111 | 
 112 | export function PaneBranchChip({ className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
 113 |   return (
 114 |     <Text
 115 |       as="button"
 116 |       {...rest}
 117 |       size="small" weight="small" tone="secondary" mono
 118 |       className={`${className} inline-flex items-center gap-[var(--space-1-5)] min-w-0 flex-none max-w-[var(--w-pane-branch-chip)] px-[var(--space-1-5)] h-[var(--h-tag-chip)] rounded-[var(--tr-radius-sm)] border-0 bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] cursor-default`.trim()}
 119 |     />
 120 |   )
 121 | }
 122 | 
 123 | /** The ended-session chip beside the header actions. */
 124 | export function PaneStateChip({
 125 |   state,
 126 |   className = '',
 127 |   ...rest
 128 | }: { state: string } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
 129 |   return (
 130 |     <Text
 131 |       as="span"
 132 |       {...rest}
 133 |       size="label"
 134 |       weight="label"
 135 |       style={{ letterSpacing: 'var(--tr-text-label-tracking)', textTransform: 'var(--tr-text-label-transform)' }}
 136 |       className={`rounded-full py-px px-[var(--space-2)] flex-none ${className} ${state === 'exited' ? 'text-[var(--status-done-text)] bg-[var(--status-done-bg)]' : 'text-[var(--status-blocked-text)] bg-[var(--status-blocked-bg)]'}`.trim()}
 137 |     />
 138 |   )
 139 | }
```

### `ui/src/renderer/src/components/ui/PaneTitle.tsx:1`

```tsx
   1 | import type { MouseEventHandler, ReactNode } from 'react'
   2 | import { Text } from './Text'
   3 | 
   4 | /** A clipped pane title that expands with the available pane width. */
   5 | export function PaneTitle({ children, editable = false, onDoubleClick }: { children: ReactNode; editable?: boolean; onDoubleClick?: MouseEventHandler<HTMLElement> }): React.JSX.Element {
   6 |   return <Text size="small" weight="medium" tone="primary" tight onDoubleClick={onDoubleClick} className={`pane-title flex [flex:0_1_auto] leading-[var(--tr-text-tight-leading)] whitespace-nowrap overflow-hidden text-ellipsis min-w-[var(--w-pane-title-min)] max-w-[var(--w-pane-title-base)] [@container_(min-width:560px)]:max-w-[var(--w-pane-title-lg)] [@container_(min-width:760px)]:max-w-[var(--w-pane-title-xl)] [@container_(min-width:1000px)]:max-w-[var(--w-pane-title-2xl)] [@container_(min-width:1300px)]:max-w-[var(--w-pane-title-3xl)] [@container_(max-width:460px)]:max-w-[var(--w-pane-title-md)] [@container_(max-width:400px)]:max-w-[var(--w-pane-title-sm)] [@container_(max-width:280px)]:max-w-[var(--w-pane-title-xs)] [@container_(max-width:200px)]:max-w-[var(--w-pane-title-xxs)] [@container_(max-width:200px)]:min-w-[var(--w-pane-title-narrow)] ${editable ? 'cursor-text border-0 border-b border-dotted border-transparent group-hover:border-b-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] group-focus-within:border-b-[color-mix(in_srgb,var(--text-muted)_55%,transparent)] [transition:border-color_0.2s,color_0.18s]' : ''}`}>{children}</Text>
   7 | }
   8 | 
```

### `ui/src/renderer/src/components/ui/StackTab.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
   2 | import { Text } from './Text'
   3 | 
   4 | export function StackTabStrip({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
   5 |   return (
   6 |     <Text
   7 |       as="div"
   8 |       {...rest}
   9 |       size="small" weight="small"
  10 |       className="stack-tabs flex items-stretch h-[var(--h-pill)] flex-none bg-[var(--card-bg)] border-b border-[var(--divider)] overflow-x-auto"
  11 |     >
  12 |       {children}
  13 |     </Text>
  14 |   )
  15 | }
  16 | 
  17 | export function StackTab({ active, children, ...rest }: { active: boolean; children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  18 |   return (
  19 |     <div
  20 |       {...rest}
  21 |       className={`group relative flex items-center gap-1 px-2 h-full [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] whitespace-nowrap cursor-pointer border-r border-[var(--divider)] [transition:background_0.12s_ease-out] ${
  22 |         active
  23 |           ? 'bg-[var(--content-bg)] text-[var(--text-primary)]'
  24 |           : 'text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]'
  25 |       }`}
  26 |     >
  27 |       {children}
  28 |     </div>
  29 |   )
  30 | }
  31 | 
  32 | export function StackTabLabel({ children }: { children: ReactNode }): React.JSX.Element {
  33 |   return <Text as="span" className="max-w-[var(--w-stack-tab-label)] truncate">{children}</Text>
  34 | }
  35 | 
  36 | /** The warning dot on a background tab whose session needs input. */
  37 | export function StackTabBadge(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  38 |   return <span {...props} className="w-1.5 h-1.5 rounded-full flex-none bg-[var(--warn)]" />
  39 | }
  40 | 
  41 | export function StackTabClose(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  42 |   return (
  43 |     <button
  44 |       {...props}
  45 |       className="border-0 bg-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
  46 |     />
  47 |   )
  48 | }
  49 | 
  50 | export function StackTabCapacity({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  51 |   return (
  52 |     <Text
  53 |       as="span"
  54 |       {...rest}
  55 |       size="label" weight="label" tone="faint" tabular
  56 |       className="flex items-center px-2"
  57 |     >
  58 |       {children}
  59 |     </Text>
  60 |   )
  61 | }
```

### `ui/src/renderer/src/components/ui/ComposerPill.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, ComponentType, HTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react'
   2 | import { BTN_PRIMARY } from './buttonChrome'
   3 | import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS } from './overlayChrome'
   4 | import { FOCUS_HALO } from './shadowChrome'
   5 | import { Text, type TextProps } from './Text'
   6 | 
   7 | type NoClass<T> = Omit<T, 'className'>
   8 | const TextButton = Text as ComponentType<TextProps & ButtonHTMLAttributes<HTMLButtonElement>>
   9 | 
  10 | const PILL_BASE_CLS = `inline-flex items-center h-[var(--h-pill)] px-[var(--space-2)] border border-[var(--border)] bg-[var(--surface)] rounded-[var(--tr-radius-pill)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`
  11 | 
  12 | const PILL_VARIANT_CLS = {
  13 |   dropdown: 'gap-[var(--space-1-5)] max-w-full disabled:opacity-50 disabled:cursor-not-allowed',
  14 |   count: ''
  15 | } as const
  16 | 
  17 | /** Pill trigger for a composer menu: `dropdown` carries an icon, label and chevron; `count` is the "+N" overflow trigger. */
  18 | export function ComposerPill({ variant, children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & {
  19 |   variant: keyof typeof PILL_VARIANT_CLS
  20 |   children: ReactNode
  21 |   'data-testid'?: string
  22 | }): React.JSX.Element {
  23 |   return <TextButton
  24 |     {...rest}
  25 |     as="button"
  26 |     type="button"
  27 |     size="small"
  28 |     weight="medium"
  29 |     tone="secondary"
  30 |     leading={variant === 'dropdown' ? 'small' : undefined}
  31 |     className={`${PILL_BASE_CLS} ${PILL_VARIANT_CLS[variant]}`}
  32 |   >{children}</TextButton>
  33 | }
  34 | 
  35 | /** The number inside a `count` pill, set in tabular figures so the pill does not jitter as it changes. */
  36 | export function ComposerPillCount({ children }: { children: ReactNode }): React.JSX.Element {
  37 |   return <Text tabular>{children}</Text>
  38 | }
  39 | 
  40 | const MENU_VARIANT_CLS = {
  41 |   options: 'left-0 gap-[var(--space-0-5)] py-[var(--space-1)] min-w-[var(--w-composer-option-menu)]',
  42 |   fields: 'right-0 gap-[var(--space-2)] p-[var(--space-2)] min-w-[var(--w-composer-field-menu)]'
  43 | } as const
  44 | 
  45 | /** Raised menu under a pill: `options` is a left-aligned list of choices, `fields` a right-aligned stack of labelled controls. */
  46 | export function ComposerPillMenu({ variant, children, ...rest }: NoClass<HTMLAttributes<HTMLDivElement>> & {
  47 |   variant: keyof typeof MENU_VARIANT_CLS
  48 |   children: ReactNode
  49 |   'data-testid'?: string
  50 | }): React.JSX.Element {
  51 |   return (
  52 |     <div {...rest} {...OVERLAY_RAISED_ATTRS} className={`${OVERLAY_RAISED_CLS} absolute top-[calc(100%+var(--space-1))] z-[var(--z-sticky)] flex flex-col ${MENU_VARIANT_CLS[variant]}`}>
  53 |       {children}
  54 |     </div>
  55 |   )
  56 | }
  57 | 
  58 | /** One choice in a pill's option list; the selected choice is bolder and primary ink. */
  59 | export function ComposerPillOption({ selected, children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & {
  60 |   selected: boolean
  61 |   children: ReactNode
  62 |   'data-testid'?: string
  63 | }): React.JSX.Element {
  64 |   return <TextButton
  65 |     {...rest}
  66 |     as="button"
  67 |     type="button"
  68 |     size="small"
  69 |     weight={selected ? 'semibold' : 'medium'}
  70 |     tone={selected ? 'primary' : 'secondary'}
  71 |     role="option"
  72 |     aria-selected={selected}
  73 |     className="flex items-center px-[var(--space-3)] min-h-[var(--h-ctl)] text-left bg-transparent border-none hover:bg-[var(--surface-hover)]"
  74 |   >{children}</TextButton>
  75 | }
  76 | 
  77 | /** Label wrapper for one control inside the overflow menu. */
  78 | export function ComposerPillField({ children, ...rest }: NoClass<LabelHTMLAttributes<HTMLLabelElement>> & { children: ReactNode }): React.JSX.Element {
  79 |   return <Text as="label" {...rest} size="small" tone="secondary" className="flex items-center justify-between gap-[var(--space-2)]">{children}</Text>
  80 | }
  81 | 
  82 | /** Row that lays composer pills out from the start with the send action pushed to the end. */
  83 | export function ComposerBar({ className = '', children, ...rest }: Omit<HTMLAttributes<HTMLDivElement>, 'className'> & {
  84 |   /** Layout classes only. */
  85 |   className?: string
  86 |   children: ReactNode
  87 |   'data-testid'?: string
  88 | }): React.JSX.Element {
  89 |   return (
  90 |     <div {...rest} className={`flex items-center gap-[var(--space-1-5)] flex-wrap ${className}`}>
  91 |       {children}
  92 |     </div>
  93 |   )
  94 | }
  95 | 
  96 | /** Primary send action of a composer; `loading` shows a spinner and blocks the click. */
  97 | export function ComposerSendButton({ loading, disabled, children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & {
  98 |   loading: boolean
  99 |   children: ReactNode
 100 |   'data-testid'?: string
 101 | }): React.JSX.Element {
 102 |   return (
 103 |     <TextButton
 104 |       {...rest}
 105 |       as="button"
 106 |       type="button"
 107 |       disabled={disabled || loading}
 108 |       aria-busy={loading || undefined}
 109 |       size="small"
 110 |       className={`btn ${BTN_PRIMARY} ml-auto h-[var(--h-pill)] px-[var(--space-3)] rounded-[var(--tr-radius-pill)] inline-flex items-center gap-[var(--space-1-5)] disabled:opacity-40 disabled:cursor-not-allowed`}
 111 |     >
 112 |       {loading && (
 113 |         <span
 114 |           role="status"
 115 |           aria-label="Loading"
 116 |           className="inline-block h-[var(--tr-icon-small-size)] w-[var(--tr-icon-small-size)] animate-spin rounded-[var(--tr-radius-pill)] [border-width:var(--tr-spinner-border)] border-current border-t-transparent opacity-70"
 117 |         />
 118 |       )}
 119 |       {children}
 120 |     </TextButton>
 121 |   )
 122 | }
```

### `ui/src/renderer/src/components/ui/LaunchComposerParts.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, HTMLAttributes, LabelHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
   2 | import { BTN_PRIMARY } from './buttonChrome'
   3 | import { MATERIAL_CLS, materialAttrs } from './material'
   4 | import { Text } from './Text'
   5 | import { Tooltip } from './Tooltip'
   6 | 
   7 | type NoClass<T> = Omit<T, 'className'>
   8 | 
   9 | /** Docked panel that holds the new-session composer: header row, scrolling body, footer row. */
  10 | export function DockedFormPanel({ children, ...rest }: NoClass<HTMLAttributes<HTMLDivElement>> & {
  11 |   children: ReactNode
  12 |   'data-testid'?: string
  13 | }): React.JSX.Element {
  14 |   return (
  15 |     <div
  16 |       {...rest}
  17 |       {...materialAttrs('base')}
  18 |       className={`flex-none min-w-0 h-full w-[var(--w-docked-form-panel)] max-w-[var(--w-docked-form-viewport-max)] grid grid-rows-[var(--h-top)_minmax(0,1fr)_var(--h-action-footer)] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
  19 |     >
  20 |       {children}
  21 |     </div>
  22 |   )
  23 | }
  24 | 
  25 | /** Scrolling body of the composer: a centred column of sections. */
  26 | export function ScrollableFormBody({ children }: { children: ReactNode }): React.JSX.Element {
  27 |   return (
  28 |     <div className="min-h-0 overflow-y-auto px-[var(--space-4-5)]">
  29 |       <div className="mx-auto flex w-full max-w-[var(--w-form-body)] flex-col gap-[var(--space-3)] pb-[var(--space-6)] pt-[calc(var(--space-3)+var(--space-0-5))]">{children}</div>
  30 |     </div>
  31 |   )
  32 | }
  33 | 
  34 | /** Fieldset whose legend is a small uppercase label. */
  35 | export function OptionFieldset({ legend, children }: { legend: string; children: ReactNode }): React.JSX.Element {
  36 |   return (
  37 |     <fieldset className="m-0 flex flex-col gap-[var(--space-2)] border-0 p-0">
  38 |       <Text as="legend" size="label" weight="label" tone="faint" leading="label" className="block p-0">{legend}</Text>
  39 |       {children}
  40 |     </fieldset>
  41 |   )
  42 | }
  43 | 
  44 | export function PresetGrid({ children }: { children: ReactNode }): React.JSX.Element {
  45 |   return <div className="grid grid-cols-4 gap-[var(--space-card-grid-gap)]">{children}</div>
  46 | }
  47 | 
  48 | export function SlotList({ children, ...rest }: { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  49 |   return <div {...rest} className="grid grid-cols-1 gap-[var(--space-card-grid-gap)]">{children}</div>
  50 | }
  51 | 
  52 | /** Row for the default-agent select with the slot counter beside it, aligned on the control baseline. */
  53 | export function InlineControlRow({ children }: { children: ReactNode }): React.JSX.Element {
  54 |   return <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-[var(--space-3)]">{children}</div>
  55 | }
  56 | 
  57 | /** A labelled control: `label` wraps the control in a `<label>`, `group` uses a plain container. */
  58 | export function LabeledControl({ label, as, className = '', children }: {
  59 |   label: string
  60 |   as: 'label' | 'group'
  61 |   /** Layout classes only. */
  62 |   className?: string
  63 |   children: ReactNode
  64 | }): React.JSX.Element {
  65 |   const Tag = as === 'label' ? 'label' : 'div'
  66 |   return (
  67 |     <Tag className={`flex flex-col gap-[var(--space-1)] ${className}`}>
  68 |       <Text size="label" weight="label" tone="faint" leading="label" className="block">{label}</Text>
  69 |       {children}
  70 |     </Tag>
  71 |   )
  72 | }
  73 | 
  74 | /** Minus, count and plus control; the buttons disable at `min` and `max`. */
  75 | export function CountStepper({ value, min, max, onChange }: {
  76 |   value: number
  77 |   min: number
  78 |   max: number
  79 |   onChange: (next: number) => void
  80 | }): React.JSX.Element {
  81 |   return (
  82 |     <div className="flex h-[var(--h-ctl)] items-center rounded-[var(--tr-radius-sm)] border border-[var(--border)]">
  83 |       <Tooltip label="Fewer"><button type="button" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className="h-full w-[var(--w-stepper-button)] border-0 bg-transparent disabled:opacity-40"><Text tone="secondary">−</Text></button></Tooltip>
  84 |       <Text data-testid="new-session-count" size="small" tabular className="min-w-[var(--h-ctl-mini)] text-center">{value}</Text>
  85 |       <Tooltip label="More"><button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className="h-full w-[var(--w-stepper-button)] border-0 bg-transparent disabled:opacity-40"><Text tone="secondary">+</Text></button></Tooltip>
  86 |     </div>
  87 |   )
  88 | }
  89 | 
  90 | /** Titled block of the composer body. */
  91 | export function FormSection({ children, ...rest }: NoClass<HTMLAttributes<HTMLElement>> & { children: ReactNode }): React.JSX.Element {
  92 |   return <section {...rest} className="flex flex-col gap-[var(--space-2)]">{children}</section>
  93 | }
  94 | 
  95 | export function SectionHeading({ children }: { children: ReactNode }): React.JSX.Element {
  96 |   return <Text as="h2" size="label" weight="label" tone="faint" leading="label" flush>{children}</Text>
  97 | }
  98 | 
  99 | /** Vertical group for one input with its label, error and counter. */
 100 | export function FieldGroup({ children }: { children: ReactNode }): React.JSX.Element {
 101 |   return <div className="flex flex-col gap-[var(--space-1-5)]">{children}</div>
 102 | }
 103 | 
 104 | export function FormLabel({ children, ...rest }: NoClass<LabelHTMLAttributes<HTMLLabelElement>> & { children: ReactNode }): React.JSX.Element {
 105 |   return <Text as="label" {...rest} size="label" weight="label" tone="faint" leading="label" className="block">{children}</Text>
 106 | }
 107 | 
 108 | /** Multi-line task input: one line tall at rest, user-resizable between the composer input height tokens. */
 109 | export function TaskInput(props: NoClass<TextareaHTMLAttributes<HTMLTextAreaElement>> & { 'data-testid'?: string }): React.JSX.Element {
 110 |   return (
 111 |     <Text as="div" size="ui" weight="ui" tone="primary" leading="composer" className="contents">
 112 |       <textarea
 113 |         {...props}
 114 |         className="block w-full min-h-[var(--h-task-input-min)] max-h-[var(--h-task-input-max)] resize-y rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-task-field-block)] [font:inherit] leading-[inherit] text-inherit placeholder:text-[var(--text-muted)] focus:[border-color:var(--accent)] focus:outline-none focus-visible:[border-color:var(--accent)]"
 115 |       />
 116 |     </Text>
 117 |   )
 118 | }
 119 | 
 120 | export function FieldError({ children, ...rest }: NoClass<HTMLAttributes<HTMLParagraphElement>> & { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
 121 |   return (
 122 |     <Text as="p" {...rest} size="small" weight="small" tone="danger" flush>
 123 |       {children}
 124 |     </Text>
 125 |   )
 126 | }
 127 | 
 128 | /** Mono readout under a field, aligned to its end. */
 129 | export function FieldCounter({ children }: { children: ReactNode }): React.JSX.Element {
 130 |   return <Text size="caption" tone="faint" mono className="self-end">{children}</Text>
 131 | }
 132 | 
 133 | /** Muted small text for a routing note or one route. */
 134 | export function RouteNote({ children }: { children: ReactNode }): React.JSX.Element {
 135 |   return <Text size="small" tone="muted">{children}</Text>
 136 | }
 137 | 
 138 | export function RouteList({ children }: { children: ReactNode }): React.JSX.Element {
 139 |   return <div className="flex flex-wrap gap-[var(--space-2)]">{children}</div>
 140 | }
 141 | 
 142 | /** Footer row: a summary on the start side and the launch action on the end. */
 143 | export function ActionFooter({ children }: { children: ReactNode }): React.JSX.Element {
 144 |   return <div className="flex items-center gap-[var(--space-action-footer-gap)] border-t border-[var(--border)] px-[var(--space-action-footer-inline)]">{children}</div>
 145 | }
 146 | 
 147 | export function InlineSummary({ children, ...rest }: NoClass<HTMLAttributes<HTMLSpanElement>> & { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
 148 |   return (
 149 |     <Text as="span" {...rest} size="small" weight="small" tone="muted" className="flex-1 min-w-0 truncate">
 150 |       {children}
 151 |     </Text>
 152 |   )
 153 | }
 154 | 
 155 | export function PrimaryAction({ children, ...rest }: NoClass<ButtonHTMLAttributes<HTMLButtonElement>> & { children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
 156 |   return (
 157 |     <button
 158 |       {...rest}
 159 |       type="button"
 160 |       className={`btn ${BTN_PRIMARY} inline-flex h-[var(--h-primary-action)] items-center rounded-[var(--tr-radius-button)] px-[var(--space-5)] disabled:opacity-40 disabled:cursor-not-allowed`}
 161 |     >
 162 |       <Text size="ui" weight="ui" className="contents">{children}</Text>
 163 |     </button>
 164 |   )
 165 | }
```

### `ui/src/renderer/src/components/ui/LaunchComposerHeader.tsx:1`

```tsx
   1 | import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
   2 | import { Icon } from './Icon'
   3 | import { IconClose } from '../icons'
   4 | import { Tooltip } from './Tooltip'
   5 | 
   6 | export function LaunchComposerHeader({ workspaceName, workspacePath, gridName, target, onClose }: {
   7 |   workspaceName: string
   8 |   workspacePath: string
   9 |   gridName: string
  10 |   target: 'this-grid' | 'new-grid'
  11 |   onClose: () => void
  12 | }): React.JSX.Element {
  13 |   return (
  14 |     <div className="flex min-h-0 items-center gap-[var(--space-2)] border-b border-[var(--border)] px-[14px]">
  15 |       <div className="flex min-w-0 flex-1 flex-col justify-center gap-0">
  16 |         <span className="[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[var(--tr-text-ui-leading)] text-[var(--text-primary)]">New sessions</span>
  17 |         <Tooltip label={workspacePath}>
  18 |           <span className="block min-w-0 truncate [font-size:var(--tr-text-label-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">
  19 |             {target === 'this-grid' ? `${workspaceName} · adds to “${gridName}”` : `${workspaceName} · opens a new grid`}
  20 |           </span>
  21 |         </Tooltip>
  22 |       </div>
  23 |       <Tooltip label="Close"><button
  24 |         type="button"
  25 |         aria-label="Close"
  26 |         data-testid="new-session-close"
  27 |         onClick={onClose}
  28 |         className={`inline-flex ${CONTROL_SIZE_SQUARE_CLS.small} flex-none items-center justify-center rounded-[var(--tr-radius-sm)] border-none bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]`}
  29 |       >
  30 |         <Icon glyph={IconClose} role="small" />
  31 |       </button></Tooltip>
  32 |     </div>
  33 |   )
  34 | }
  35 | 
```

### `ui/src/renderer/src/components/ui/LaunchPresetCard.tsx:1`

```tsx
   1 | import { LaunchPresetOutline } from './LaunchLayoutPreview'
   2 | 
   3 | const CARD_BASE = 'w-full text-left border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]'
   4 | const CARD_STATE = {
   5 |   selected: 'border-[var(--border-active)] bg-[var(--card-hover)]',
   6 |   idle: 'border-[var(--border)] bg-[var(--card-bg)] hover:border-[var(--border-hover)] hover:bg-[var(--card-hover)]'
   7 | } as const
   8 | 
   9 | export interface LaunchPresetCardProps {
  10 |   id: string
  11 |   name: string
  12 |   blurb: string
  13 |   count: number
  14 |   selected: boolean
  15 |   onSelect: () => void
  16 |   onPreviewStart: () => void
  17 |   onPreviewEnd: () => void
  18 | }
  19 | 
  20 | export function LaunchPresetCard({ id, name, blurb, count, selected, onSelect, onPreviewStart, onPreviewEnd }: LaunchPresetCardProps): React.JSX.Element {
  21 |   return (
  22 |     <button
  23 |       type="button"
  24 |       data-preset={id}
  25 |       aria-pressed={selected}
  26 |       onClick={onSelect}
  27 |       onMouseEnter={onPreviewStart}
  28 |       onMouseLeave={onPreviewEnd}
  29 |       className={`${CARD_BASE} ${selected ? CARD_STATE.selected : CARD_STATE.idle} flex min-w-0 flex-col gap-[5px] rounded-[var(--tr-radius-md)] px-[9px] pt-[9px] pb-[7px]`}
  30 |     >
  31 |       <span className="flex w-full items-center leading-[15px]"><LaunchPresetOutline count={count} /></span>
  32 |       <span className="flex w-full min-w-0 items-center gap-[var(--space-1)] leading-[15px]">
  33 |         <span className="min-w-0 flex-1 whitespace-nowrap [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">{name}</span>
  34 |         <span className={`[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tabular-nums ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}>{count}</span>
  35 |       </span>
  36 |       <span className="whitespace-normal [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">{blurb}</span>
  37 |     </button>
  38 |   )
  39 | }
```

### `ui/src/renderer/src/components/ui/LaunchSlotCard.tsx:1`

```tsx
   1 | import type { AgentKind } from '../../houston/generated/AgentKind'
   2 | import type { ChatEffort } from '../../houston/generated/ChatEffort'
   3 | import { useState } from 'react'
   4 | import type { SessionSlot, SlotOverrides } from '../sessionPresets'
   5 | import { Select } from './Select'
   6 | import { IconAgent } from '../icons'
   7 | import { ICON_ROLE_CLS } from './Icon'
   8 | import { FieldLabel } from './Field'
   9 | 
  10 | const AGENTS: readonly AgentKind[] = ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'grok', 'shell']
  11 | const LABELS: Record<AgentKind, string> = {
  12 |   claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor Agent', antigravity: 'Antigravity',
  13 |   opencode: 'OpenCode', grok: 'Grok Build', shell: 'Terminal', custom: 'Custom', ssh: 'SSH',
  14 |   droid: 'Droid', copilot: 'Copilot', aider: 'Aider'
  15 | }
  16 | const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
  17 | 
  18 | export interface LaunchSlotCardProps {
  19 |   slot: SessionSlot
  20 |   workspaceName: string
  21 |   override: SlotOverrides
  22 |   onAgentChange: (agent: AgentKind) => void
  23 |   onModelChange: (model: string | null) => void
  24 |   onEffortChange: (effort: ChatEffort | null) => void
  25 |   onReset: () => void
  26 | }
  27 | 
  28 | const FIELD = 'flex min-w-0 flex-col gap-[var(--space-1)]'
  29 | const SOURCE = '[font-size:var(--tr-text-label-size)] text-[var(--text-muted)]'
  30 | const FIELD_VALUE = 'min-w-0 truncate rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-2)] py-[var(--space-1)] [font-size:var(--tr-text-small-size)] text-[var(--text-primary)]'
  31 | const editedBorderClass = (isEdited: boolean): string => isEdited ? 'border-[color-mix(in_srgb,var(--warn)_55%,transparent)]' : ''
  32 | 
  33 | const MODEL_OPTIONS: Partial<Record<AgentKind, string[]>> = {
  34 |   claude: ['opus', 'sonnet', 'haiku'],
  35 |   codex: ['gpt-5.5-codex', 'gpt-5.4', 'gpt-5-codex']
  36 | }
  37 | 
  38 | function LaunchModelSelect({ agent, value, onChange, slot, className = '' }: {
  39 |   agent: AgentKind
  40 |   value: string | null
  41 |   onChange: (model: string | null) => void
  42 |   slot: number
  43 |   className?: string
  44 | }): React.JSX.Element {
  45 |   const [customSelected, setCustomSelected] = useState(false)
  46 |   const known = MODEL_OPTIONS[agent] ?? []
  47 |   const isKnown = value === null || value === '' || known.includes(value)
  48 |   const isCustom = customSelected || !isKnown
  49 |   const options = [
  50 |     { value: '', label: 'Default model' },
  51 |     ...known.map((model) => ({ value: model, label: model })),
  52 |     { value: '__custom__', label: 'Type model ID…' }
  53 |   ]
  54 |   return (
  55 |     <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
  56 |       <Select
  57 |         aria-label={`Model override for slot ${slot + 1}`}
  58 |         className={className}
  59 |         value={isCustom ? '__custom__' : value ?? ''}
  60 |         options={options}
  61 |         onChange={(next) => {
  62 |           setCustomSelected(next === '__custom__')
  63 |           if (next !== '__custom__') onChange(next || null)
  64 |         }}
  65 |       />
  66 |       {isCustom && (
  67 |         <input
  68 |           aria-label={`Typed model ID for slot ${slot + 1}`}
  69 |           value={value ?? ''}
  70 |           placeholder="Model ID"
  71 |           onChange={(event) => onChange(event.target.value || null)}
  72 |           className={`${FIELD_VALUE} ${className}`}
  73 |         />
  74 |       )}
  75 |     </div>
  76 |   )
  77 | }
  78 | 
  79 | export function LaunchSlotCard({ slot, workspaceName, override, onAgentChange, onModelChange, onEffortChange, onReset }: LaunchSlotCardProps): React.JSX.Element {
  80 |   const editedAgent = override.agent !== undefined
  81 |   const editedModel = override.model !== undefined
  82 |   const editedEffort = override.effort !== undefined
  83 |   const edited = editedAgent || editedModel || editedEffort
  84 |   const headerSource = edited ? 'edited' : slot.headerSource === 'user override' ? 'edited' : slot.headerSource ?? slot.agentSource
  85 |   return (
  86 |     <div data-slot={slot.index} className="flex min-w-0 flex-col gap-[var(--space-2)] rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-2)]">
  87 |       <div className="flex min-w-0 items-center gap-[var(--space-1-5)]">
  88 |         <span className="w-3 flex-none font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-faint)]">{slot.index + 1}</span>
  89 |         <IconAgent agent={slot.agent} brand className={ICON_ROLE_CLS.small} />
  90 |         <span className="min-w-0 flex-1 truncate [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] text-[var(--text-primary)]">
  91 |           {slot.roleLabel ?? LABELS[slot.agent] ?? slot.agent}
  92 |         </span>
  93 |         <span className={`${SOURCE} ${edited ? 'text-[var(--warn)]' : ''}`}>{headerSource}</span>
  94 |         {edited && <button type="button" aria-label={`Reset slot ${slot.index + 1}`} onClick={onReset} className="border-0 bg-transparent p-0 [font-size:var(--tr-text-label-size)] text-[var(--text-muted)] hover:text-[var(--text-primary)]">↺ reset</button>}
  95 |       </div>
  96 |       <div className="grid grid-cols-2 gap-x-[var(--space-2)] gap-y-[var(--space-1-5)]">
  97 |         <div className={FIELD}>
  98 |           <FieldLabel size="compact">Agent</FieldLabel>
  99 |           <Select className={editedBorderClass(editedAgent)} aria-label={`Agent override for slot ${slot.index + 1}`} value={slot.agent}
 100 |             options={AGENTS.map((value) => ({ value, label: LABELS[value] }))} onChange={(value) => onAgentChange(value as AgentKind)} />
 101 |         </div>
 102 |         <div className={FIELD}>
 103 |           <FieldLabel size="compact">Model</FieldLabel>
 104 |           <LaunchModelSelect className={editedBorderClass(editedModel)} agent={slot.agent} slot={slot.index} value={override.model ?? slot.model} onChange={onModelChange} />
 105 |         </div>
 106 |         <div className={FIELD}>
 107 |           <FieldLabel size="compact">Effort</FieldLabel>
 108 |           <Select className={editedBorderClass(editedEffort)} aria-label={`Effort override for slot ${slot.index + 1}`} value={override.effort ?? slot.effort ?? ''}
 109 |             options={[{ value: '', label: 'Default effort' }, ...EFFORTS.map((value) => ({ value, label: value }))]}
 110 |             onChange={(value) => onEffortChange(value ? value as ChatEffort : null)} />
 111 |         </div>
 112 |         <div className={FIELD}>
 113 |           <FieldLabel size="compact">Checkout</FieldLabel>
 114 |           <span className={FIELD_VALUE}>This checkout · {workspaceName}</span>
 115 |         </div>
 116 |       </div>
 117 |       {slot.skippedRoute && <span role="status">Skipped route: {slot.skippedRoute}</span>}
 118 |       {slot.invalidReason && <span role="alert" className="[font-size:var(--tr-text-small-size)] text-[var(--danger)]">{slot.invalidReason}</span>}
 119 |     </div>
 120 |   )
 121 | }
 122 | 
```

### `ui/src/renderer/src/components/ui/Button.tsx:1`

```tsx
   1 | import { useContext, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
   2 | import { BTN_DANGER_SOLID, BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER, BTN_ICO, BTN_PRIMARY } from './buttonChrome'
   3 | import type { IconComponent } from '../icons'
   4 | import { variants } from './variants'
   5 | import { FOCUS_HALO } from './shadowChrome'
   6 | import './button.css'
   7 | import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
   8 | import { Tooltip, TooltipContext } from './Tooltip'
   9 | 
  10 | export type ButtonVariant = 'primary' | 'secondary' | 'field' | 'ghost' | 'link' | 'danger' | 'danger-solid' | 'icon' | 'icon-selected' | 'icon-structure' | 'text' | 'badge' | 'ghost-icon' | 'ghost-icon-danger' | 'confirm-primary' | 'compact-outline' | 'danger-confirmation' | 'legacy-primary' | 'legacy-ghost' | 'legacy-danger' | 'legacy-danger-solid' | 'legacy-icon' | 'legacy-roster-footer' | 'legacy-icon-warning' | 'legacy-titlebar-icon' | 'legacy-ghost-compact' | 'roster-open' | 'mini-primary-action' | 'action-primary' | 'surface' | 'surface-large' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon' | 'status-chip'
  11 | export type ButtonSize = 'md' | 'sm' | 'lg'
  12 | 
  13 | interface ButtonBaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> {
  14 |   size?: ButtonSize
  15 |   armed?: boolean
  16 |   selected?: boolean
  17 |   status?: 'available' | 'failed'
  18 |   contentAlign?: 'start' | 'center'
  19 |   iconEnd?: IconComponent
  20 |   /** Layout classes only; visual styles belong in Button variants. */
  21 |   className?: string
  22 |   noDrag?: boolean
  23 |   type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  24 |   ref?: Ref<HTMLButtonElement>
  25 | }
  26 | 
  27 | type CoreButtonVariant = ButtonVariant
  28 | 
  29 | type LabeledButtonProps = ButtonBaseProps & {
  30 |   variant?: Exclude<CoreButtonVariant, 'icon' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon' | 'danger-solid'>
  31 |   icon?: IconComponent
  32 |   children?: ReactNode
  33 |   'aria-label'?: string
  34 | }
  35 | 
  36 | type DangerSolidButtonProps = ButtonBaseProps & {
  37 |   variant: 'danger-solid'
  38 |   icon: IconComponent
  39 |   children?: ReactNode
  40 |   'aria-label'?: string
  41 | }
  42 | 
  43 | type IconButtonProps = ButtonBaseProps & {
  44 |   variant: 'icon' | 'subtle-icon' | 'compact-icon' | 'compact-icon-secondary' | 'disclosure-icon' | 'small-icon'
  45 |   icon?: IconComponent
  46 |   children?: ReactNode
  47 |   'aria-label': string
  48 |   iconEnd?: never
  49 | }
  50 | 
  51 | export type ButtonProps = LabeledButtonProps | DangerSolidButtonProps | IconButtonProps
  52 | 
  53 | export type ButtonRecipeProps = ButtonBaseProps & {
  54 |   icon?: IconComponent
  55 |   children?: ReactNode
  56 |   'aria-label'?: string
  57 | }
  58 | 
  59 | export function ButtonFrame({
  60 |   className = '',
  61 |   icon,
  62 |   iconEnd,
  63 |   children,
  64 |   type = 'button',
  65 |   ref,
  66 |   size: _size,
  67 |   armed: _armed,
  68 |   selected: _selected,
  69 |   status: _status,
  70 |   contentAlign: _contentAlign,
  71 |   noDrag: _noDrag,
  72 |   ...buttonProps
  73 | }: ButtonRecipeProps): React.JSX.Element {
  74 |   const Icon = icon
  75 |   const EndIcon = iconEnd
  76 |   return (
  77 |     <button {...buttonProps} ref={ref} type={type} className={className}>
  78 |       {Icon && <Icon />}
  79 |       {children}
  80 |       {EndIcon && <EndIcon />}
  81 |     </button>
  82 |   )
  83 | }
  84 | 
  85 | const sizeClasses = {
  86 |   md: 'h-[var(--h-ctl)] px-[var(--space-3)] gap-[var(--space-1-5)]',
  87 |   sm: 'h-[var(--h-ctl-mini)] px-[var(--space-2)] gap-[var(--space-1-5)]',
  88 |   lg: 'h-[var(--h-empty-action)] px-[var(--space-5)] gap-[var(--space-2)]',
  89 |   icon: ''
  90 | } as const
  91 | 
  92 | const buttonClasses = variants(
  93 |   'btn inline-flex items-center justify-center disabled:cursor-not-allowed',
  94 |   {
  95 |     variant: {
  96 |       primary: 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:enabled:bg-[var(--accent-hover)]',
  97 |       'action-primary': `btn rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] ${BTN_PRIMARY}`,
  98 |       secondary: 'border-[var(--border)] bg-[var(--hover-fill)] text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
  99 |       field: 'justify-start border-[var(--border)] bg-[var(--card-bg)] text-left font-normal text-[var(--text-secondary)] hover:enabled:border-[var(--border-hover)] hover:enabled:bg-[var(--card-hover)] hover:enabled:text-[var(--text-primary)]',
 100 |       surface: 'border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-secondary)] font-medium hover:enabled:bg-[var(--surface-hover)] hover:enabled:text-[var(--text-primary)]',
 101 |       'surface-large': 'h-[var(--h-empty-action)] px-[var(--space-4)] gap-[var(--space-2)] rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] [font-size:var(--tr-text-ui-size)] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
 102 |       ghost: `btn ${BTN_GHOST}`,
 103 |       link: 'border-transparent bg-transparent !px-0 !py-0 !h-auto min-h-0 align-baseline text-[length:var(--tr-text-small-size)] text-[var(--accent)] hover:enabled:bg-transparent hover:enabled:underline',
 104 |       danger: `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
 105 |       'danger-solid': BTN_DANGER_SOLID,
 106 |       icon: BTN_ICO,
 107 |       'icon-selected': `${BTN_ICO} bg-[var(--card-hover)] text-[var(--text-primary)]`,
 108 |       'icon-structure': `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] bg-transparent border-none p-0 leading-none inline-flex items-center justify-center flex-none text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] hover:text-[var(--text-primary)] focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:outline-none disabled:opacity-45 disabled:cursor-not-allowed [&_svg]:block [&_svg]:flex-none`,
 109 |       'subtle-icon': 'border-none p-0 leading-none inline-flex items-center justify-center flex-none w-[var(--h-ctl)] h-[var(--h-ctl)] rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] [&_svg]:block [&_svg]:flex-none',
 110 |       'compact-icon': 'relative border-0 bg-transparent w-[var(--sz-rail-compact-action)] h-[var(--sz-rail-compact-action)] p-0 flex-none rounded-[var(--tr-radius-sm)] inline-flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]',
 111 |       'compact-icon-secondary': 'relative w-[var(--sz-rail-compact-action)] h-[var(--sz-rail-compact-action)] flex-none rounded-[var(--tr-radius-sm)] border-0 bg-transparent p-0 inline-flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]',
 112 |       'disclosure-icon': 'relative -ml-[var(--space-disclosure-nudge)] flex items-center justify-center w-[var(--sz-disclosure-icon)] h-[var(--sz-disclosure-icon)] rounded-[var(--tr-radius-input)] text-current hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] after:absolute after:left-1/2 after:top-1/2 after:h-[var(--h-disclosure-hit)] after:min-w-[var(--h-disclosure-hit)] after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-[\'\']',
 113 |       'small-icon': 'items-center justify-center w-[var(--sz-rail-row-action)] h-[var(--sz-rail-row-action)] p-0 flex-none text-[var(--text-muted)] rounded-[var(--tr-radius-input)] leading-[0] hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)]',
 114 |       'status-chip': 'border-none p-0 leading-none inline-flex items-center justify-center flex-none ml-auto h-[var(--h-ctl)] gap-[var(--space-1-5)] px-[var(--space-2-5)] rounded-full whitespace-nowrap [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-update-weight)]',
 115 |       text: 'h-auto min-h-0 border-0 bg-transparent p-0 text-left font-semibold text-[var(--text-primary)] hover:enabled:bg-transparent hover:enabled:text-[var(--text-primary)]',
 116 |       badge: 'h-auto min-h-0 border-0 bg-transparent p-0 inline-flex items-center text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] flex-none whitespace-nowrap cursor-default gap-1.5 [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]',
 117 |       'ghost-icon': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)]`,
 118 |       'ghost-icon-danger': `btn ${BTN_GHOST} p-1 rounded-[var(--tr-radius-sm)] enabled:hover:text-[var(--danger)]`,
 119 |       'confirm-primary': `h-[var(--h-ctl)] px-[var(--space-4)] rounded-[var(--tr-radius-button)] border border-[var(--accent)] bg-[var(--accent)] text-[var(--primary-foreground)] [font-size:var(--tr-text-ui-size)] font-semibold hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-40`,
 120 |       'compact-outline': `bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current [font-size:var(--tr-text-small-size)] font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] relative after:absolute after:left-1/2 after:top-1/2 after:h-[var(--h-ctl)] after:min-w-[var(--h-ctl)] after:w-full after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']`,
 121 |       'danger-confirmation': `h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-button)] border [font-size:var(--tr-text-ui-size)] font-medium whitespace-nowrap focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed`,
 122 |       'mini-primary-action': `btn ${BTN_PRIMARY} inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-ctl-mini)] px-[var(--space-1-5)] disabled:opacity-55`,
 123 |       'legacy-primary': `btn ${BTN_PRIMARY}`,
 124 |       'legacy-ghost': `btn ${BTN_GHOST}`,
 125 |       'legacy-danger': `btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER}`,
 126 |       'legacy-danger-solid': BTN_DANGER_SOLID,
 127 |       'legacy-icon': `btn ${BTN_ICO}`,
 128 |       'legacy-icon-warning': `btn ${BTN_ICO} text-warning hover:text-warning`,
 129 |       'legacy-titlebar-icon': `btn ${BTN_ICO} [-webkit-app-region:no-drag]`,
 130 |       'legacy-ghost-compact': `btn ${BTN_GHOST} px-2 py-1 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] inline-flex items-center gap-1`,
 131 |       'legacy-roster-footer': `btn ${BTN_GHOST} min-h-[var(--h-ctl)]`,
 132 |       'roster-open': 'h-auto p-0 border-0 bg-transparent grid-cols-[16px_16px_minmax(0,1fr)_auto] gap-x-[var(--space-1)] [&>*:nth-child(-n+2)]:justify-self-center flex-1 min-w-0 min-h-[19px] text-left text-[var(--text-secondary)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] whitespace-nowrap cursor-default [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px] [&_strong]:font-semibold [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap'
 133 |     },
 134 |     size: sizeClasses
 135 |   },
 136 |   { variant: 'secondary', size: 'md' }
 137 | )
 138 | 
 139 | // Variants that carry their own type and padding: no button chrome, no size padding.
 140 | const SELF_SIZED: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>(['icon', 'icon-selected', 'icon-structure', 'text', 'badge', 'confirm-primary', 'compact-outline', 'danger-confirmation', 'roster-open', 'mini-primary-action', 'subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip', 'surface-large'])
 141 | const OWN_CHROME: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>(['badge', 'confirm-primary', 'compact-outline', 'danger-confirmation', 'roster-open', 'mini-primary-action', 'surface-large', 'action-primary', 'subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip'])
 142 | const isLegacy = (variant: CoreButtonVariant): boolean => variant.startsWith('legacy-')
 143 | 
 144 | function buttonSize(variant: CoreButtonVariant, size: ButtonSize): ButtonSize | 'icon' {
 145 |   return SELF_SIZED.has(variant) || variant.includes('icon') || isLegacy(variant) ? 'icon' : size
 146 | }
 147 | 
 148 | function buttonChrome(variant: CoreButtonVariant): string {
 149 |   return OWN_CHROME.has(variant) || isLegacy(variant) ? '' : 'rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)]'
 150 | }
 151 | 
 152 | const BARE_ICON_VARIANTS: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>(['subtle-icon', 'compact-icon', 'compact-icon-secondary', 'disclosure-icon', 'small-icon', 'status-chip'])
 153 | const TOOLTIP_ICON_VARIANTS: ReadonlySet<CoreButtonVariant> = new Set<CoreButtonVariant>([
 154 |   'icon', 'icon-selected', 'icon-structure', 'subtle-icon', 'compact-icon', 'compact-icon-secondary',
 155 |   'small-icon', 'ghost-icon', 'ghost-icon-danger', 'legacy-icon', 'legacy-icon-warning', 'legacy-titlebar-icon'
 156 | ])
 157 | 
 158 | // Prefix rewrites for variants whose recipe drops part of the shared `btn inline-flex …` head.
 159 | const HEAD_REWRITE: Partial<Record<CoreButtonVariant, [RegExp, string]>> = {
 160 |   'legacy-roster-footer': [/^btn inline-flex items-center (?:justify-center )?disabled:cursor-not-allowed /, ''],
 161 |   'roster-open': [/^btn inline-flex /, 'grid '],
 162 |   'legacy-danger-solid': [/^btn inline-flex items-center disabled:cursor-not-allowed /, 'btn ']
 163 | }
 164 | 
 165 | function structureClasses(variant: CoreButtonVariant, size: ButtonSize, contentAlign: 'center' | 'start'): string {
 166 |   const selectedClasses = buttonClasses({ variant, size: buttonSize(variant, size) })
 167 |   const aligned = contentAlign === 'start' ? selectedClasses.replace(' justify-center', '') : selectedClasses
 168 |   const rewrite = BARE_ICON_VARIANTS.has(variant)
 169 |     ? ([/^btn inline-flex items-center justify-center disabled:cursor-not-allowed /, ''] as [RegExp, string])
 170 |     : HEAD_REWRITE[variant]
 171 |   const classSet = rewrite ? aligned.replace(rewrite[0], rewrite[1]) : aligned
 172 |   return variant === 'badge' ? classSet.replace(/\bbtn\b/g, '') : classSet
 173 | }
 174 | 
 175 | function selectionClasses(variant: CoreButtonVariant, selected: boolean): string {
 176 |   if (!selected) return ''
 177 |   return variant === 'subtle-icon' ? 'bg-selected-fill text-[var(--text-primary)]' : ''
 178 | }
 179 | 
 180 | function stateClasses(variant: CoreButtonVariant, selected: boolean, armed: boolean, status: 'available' | 'failed'): string {
 181 |   const arm = (variant === 'danger' || variant === 'legacy-danger') && armed ? BTN_GHOST_DANGER_ARM : ''
 182 |   const chip = variant !== 'status-chip'
 183 |     ? ''
 184 |     : status === 'failed'
 185 |       ? 'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-[var(--warn)] hover:bg-[color-mix(in_srgb,var(--warn)_24%,transparent)]'
 186 |       : 'bg-[var(--accent-muted)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]'
 187 |   return `${selectionClasses(variant, selected)} ${arm} ${chip}`
 188 | }
 189 | 
 190 | export function Button(props: ButtonProps): React.JSX.Element {
 191 |   const {
 192 |     variant = 'secondary',
 193 |     size = 'md',
 194 |     armed = false,
 195 |     selected = false,
 196 |     status = 'available',
 197 |     contentAlign = 'center',
 198 |     icon,
 199 |     iconEnd,
 200 |     className = '',
 201 |     noDrag = false,
 202 |     children,
 203 |     type = 'button',
 204 |     ref,
 205 |     ...buttonProps
 206 |   } = props
 207 |   const classes = `${structureClasses(variant, size, contentAlign)} ${variant === 'roster-open' ? 'children-open' : ''} ${buttonChrome(variant)} ${stateClasses(variant, selected, armed, status)} ${noDrag ? '[-webkit-app-region:no-drag]' : ''} ${className}`
 208 |   const button = <ButtonFrame {...buttonProps} size={size} armed={armed} selected={selected} status={status} contentAlign={contentAlign} icon={icon} iconEnd={iconEnd} noDrag={noDrag} children={children} type={type} ref={ref} className={classes} />
 209 |   const label = buttonProps['aria-label']
 210 |   const parentTooltip = useContext(TooltipContext)
 211 |   return TOOLTIP_ICON_VARIANTS.has(variant) && label && !parentTooltip ? <Tooltip label={label}>{button}</Tooltip> : button
 212 | }
```

### `ui/src/renderer/src/components/ui/buttonChrome.ts:1`

```tsx
   1 | export const BTN_PRIMARY =
   2 |   'bg-[var(--accent)] [border-color:var(--accent)] text-white font-bold ' +
   3 |   'hover:bg-[var(--accent-hover)]'
   4 | 
   5 | // text-white is a fixed contrast pair, not a themed surface: every theme's
   6 | // --danger is dark enough (#ef4444/#dc2626) for white to clear 4.5:1, which
   7 | // check:css enforces.
   8 | export const BTN_DANGER_SOLID =
   9 |   'bg-[var(--danger)] [border-color:var(--danger)] text-white font-bold ' +
  10 |   'hover:bg-[color-mix(in_srgb,var(--danger)_85%,black)]'
  11 | 
  12 | export const BTN_SECONDARY =
  13 |   'btn border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] hover:enabled:bg-[var(--hover-fill)] disabled:opacity-55'
  14 | 
  15 | // Background half of the ghost look, for sites that keep their own text colour
  16 | // and border (App.tsx's inherit-colour button).
  17 | export const BTN_GHOST_BG = 'bg-transparent'
  18 | 
  19 | // A component-layer class (base.css) that owns the hover state: call-site
  20 | // utilities and the danger variants below win by layer, not by tie-break order.
  21 | // Its `border: none` resets border-style, so border-color alone paints nothing.
  22 | export const BTN_GHOST = 'btn-ghost'
  23 | 
  24 | // Signal through fill + text, not border-color (BTN_GHOST has no border style).
  25 | // Utilities outrank BTN_GHOST's component-layer hover, so this wins on its own.
  26 | export const BTN_GHOST_DANGER_HOVER =
  27 |   'hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] hover:text-[var(--danger)]'
  28 | 
  29 | export const BTN_GHOST_DANGER_ARM =
  30 |   'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] font-semibold'
  31 | 
  32 | export const BTN_ICO =
  33 |   'bg-transparent border-none text-[var(--text-muted)] w-6 h-[var(--h-ctl-mini)] p-0 ' +
  34 |   'leading-none inline-flex items-center justify-center flex-none rounded-[var(--tr-radius-sm)] ' +
  35 |   'hover:text-[var(--text-primary)] hover:bg-[var(--card-hover)] ' +
  36 |   '[&_svg]:block [&_svg]:flex-none'
  37 | 
  38 | // Subset of BTN_ICO carrying only what no icon-header call site overrides
  39 | // (shape, resets, svg pair) -- adding BTN_ICO's own colors here would tie
  40 | // with the utilities those sites already layer on top.
  41 | export const BTN_ICO_STRUCTURE =
  42 |   'border-none p-0 leading-none inline-flex items-center justify-center flex-none ' +
  43 |   '[&_svg]:block [&_svg]:flex-none'
  44 | 
  45 | export const LINK_INLINE =
  46 |   'underline text-[var(--accent)] bg-transparent border-0 p-0 font-[inherit] cursor-pointer ' +
  47 |   'hover:text-[var(--accent-hover)] ' +
  48 |   'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]'
```

### `ui/src/renderer/src/components/ui/button.css:1`

```tsx
   1 | /* Restates tailwind.css's layer order: this sheet can load first, and a layer is placed where it is first seen. */
   2 | @layer properties, theme, base, components, utilities;
   3 | 
   4 | @layer base {
   5 |   .btn {
   6 |     /* An icon is display:block (Icon.tsx), so the button itself must be the
   7 |        flex row or the label breaks onto its own line. */
   8 |     display: inline-flex;
   9 |     align-items: center;
  10 |     gap: var(--space-1-5);
  11 |     border-radius: var(--tr-radius-button);
  12 |     border: 1px solid var(--border);
  13 |     background: var(--card-bg);
  14 |     padding: var(--button-block-padding) var(--space-3);
  15 |     font-size: var(--tr-text-sm);
  16 |     font-weight: 500;
  17 |   }
  18 |   .btn:hover {
  19 |     border-color: var(--border-hover);
  20 |     background: var(--card-hover);
  21 |   }
  22 | }
  23 | 
  24 | /* Ghost buttons live below `utilities` so every utility a call site adds (its
  25 |    own text colour, a danger hover tint, an armed fill) wins by layer rather
  26 |    than by Tailwind's alphabetical tie-break. */
  27 | @layer components {
  28 |   .btn-ghost {
  29 |     background: transparent;
  30 |     border: none;
  31 |     color: var(--text-muted);
  32 |   }
  33 |   .btn-ghost:hover:not(:disabled) {
  34 |     background: var(--hover-fill);
  35 |     color: var(--text-primary);
  36 |   }
  37 | }
```

### `ui/src/renderer/src/components/ui/Select.tsx:1`

```tsx
   1 | import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
   2 | import { useNativeOverlaySuppression } from '../../layout/nativeSuppression'
   3 | import { IconCheck, IconChevronDown } from '../icons'
   4 | import { OVERLAY_RAISED_CLS, OVERLAY_RAISED_ATTRS } from './overlayChrome'
   5 | import { SELECT_CLS } from './selectChrome'
   6 | import { Text } from './Text'
   7 | import { Icon } from './Icon'
   8 | import { Tooltip } from './Tooltip'
   9 | import { AnimOut } from './AnimOut'
  10 | import { anchorPopoverStart } from './popoverMotion'
  11 | 
  12 | const TRIGGER_LAYOUT_CLS =
  13 |   'inline-flex items-center justify-between gap-[var(--space-2)] ' +
  14 |   'cursor-pointer text-left data-[open]:border-[var(--border-hover)]'
  15 | 
  16 | export interface SelectOption {
  17 |   value: string
  18 |   label: string
  19 |   title?: string
  20 |   disabled?: boolean
  21 | }
  22 | 
  23 | export interface SelectProps {
  24 |   value: string
  25 |   options: readonly SelectOption[]
  26 |   onChange: (value: string) => void
  27 |   disabled?: boolean
  28 |   title?: string
  29 |   'aria-label'?: string
  30 |   'data-testid'?: string
  31 |   className?: string
  32 |   chrome?: string
  33 |   variant?: 'default' | 'property-chip' | 'property-field'
  34 |   prefix?: React.ReactNode
  35 |   width?: 'auto' | 'full' | 'task-setting' | 'medium'
  36 | }
  37 | 
  38 | // How long a type-ahead buffer survives between keystrokes. 800 ms sits between
  39 | // WebKit's 1 s and GTK's 500 ms; too short splits "ne|rd", too long glues jumps.
  40 | const TYPEAHEAD_RESET_MS = 800
  41 | 
  42 | const MENU_MAX_H = 320
  43 | 
  44 | const MENU_GAP = 4
  45 | const VIEWPORT_MARGIN = 8
  46 | 
  47 | interface MenuPos {
  48 |   left: number
  49 |   width: number
  50 |   top?: number
  51 |   bottom?: number
  52 |   maxHeight: number
  53 | }
  54 | 
  55 | const TRIGGER_CHROME: Partial<Record<NonNullable<SelectProps['variant']>, string>> = {
  56 |   'property-chip': 'h-[var(--task-inline-control-height)] pl-[var(--space-2)] pr-[var(--space-1-5)] gap-[var(--space-1-5)]! border border-[var(--border)]! rounded-[var(--tr-radius-button)] bg-transparent text-[var(--text-secondary)] text-[length:var(--tr-text-sm)] font-normal',
  57 |   'property-field': 'h-[var(--h-ctl)] pl-[var(--space-2)] pr-[var(--space-1-5)] gap-[var(--space-1-5)]! border border-[var(--border)]! rounded-[var(--tr-radius-button)] bg-transparent text-[var(--text-secondary)] text-[length:var(--tr-text-sm)] font-normal'
  58 | }
  59 | const TRIGGER_WIDTH: Record<NonNullable<SelectProps['width']>, string> = {
  60 |   auto: '',
  61 |   full: 'w-full',
  62 |   'task-setting': 'min-w-[var(--tr-width-task-select)]',
  63 |   medium: 'w-[var(--tr-control-width-medium)]'
  64 | }
  65 | const VALUE_TEXT: Record<NonNullable<SelectProps['variant']>, { size?: 'sm'; tone?: 'secondary' }> = {
  66 |   default: {},
  67 |   'property-chip': { size: 'sm', tone: 'secondary' },
  68 |   'property-field': { size: 'sm', tone: 'secondary' }
  69 | }
  70 | 
```

### `ui/src/renderer/src/components/ui/Select.tsx:253`

```tsx
 253 | 
 254 |   return (
 255 |     <>
 256 |       <Tooltip label={title} className={disabled ? 'inline-flex' : undefined}>
 257 |         <button
 258 |           ref={triggerRef}
 259 |           type="button"
 260 |           role="combobox"
 261 |           aria-haspopup="listbox"
 262 |           aria-expanded={open}
 263 |           aria-controls={open ? listboxId : undefined}
```

### `ui/src/renderer/src/components/ui/Select.tsx:278`

```tsx
 278 |               openMenu()
 279 |             }
 280 |           }}
 281 |           className={`${triggerChrome} ${TRIGGER_LAYOUT_CLS} ${TRIGGER_WIDTH[width]} ${className}`}
 282 |         >
 283 |           {prefix && <Text as="span" size={VALUE_TEXT[variant].size} className="flex-none inline-flex items-center">{prefix}</Text>}
 284 |           <Text as="span" size={VALUE_TEXT[variant].size} tone={VALUE_TEXT[variant].tone} className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</Text>
 285 |           <Icon glyph={IconChevronDown} role="small" className="flex-none text-[var(--text-muted)]" />
 286 |         </button>
 287 |       </Tooltip>
 288 |       <AnimOut open={open && pos !== null} suppress="popover" scopeRef={menuRef}>
```

### `ui/src/renderer/src/components/ui/Select.tsx:280`

```tsx
 280 |           }}
 281 |           className={`${triggerChrome} ${TRIGGER_LAYOUT_CLS} ${TRIGGER_WIDTH[width]} ${className}`}
 282 |         >
 283 |           {prefix && <Text as="span" size={VALUE_TEXT[variant].size} className="flex-none inline-flex items-center">{prefix}</Text>}
 284 |           <Text as="span" size={VALUE_TEXT[variant].size} tone={VALUE_TEXT[variant].tone} className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</Text>
 285 |           <Icon glyph={IconChevronDown} role="small" className="flex-none text-[var(--text-muted)]" />
 286 |         </button>
 287 |       </Tooltip>
 288 |       <AnimOut open={open && pos !== null} suppress="popover" scopeRef={menuRef}>
 289 |         {open && pos && (
 290 |           <div
```

### `ui/src/renderer/src/components/ui/Select.tsx:281`

```tsx
 281 |           className={`${triggerChrome} ${TRIGGER_LAYOUT_CLS} ${TRIGGER_WIDTH[width]} ${className}`}
 282 |         >
 283 |           {prefix && <Text as="span" size={VALUE_TEXT[variant].size} className="flex-none inline-flex items-center">{prefix}</Text>}
 284 |           <Text as="span" size={VALUE_TEXT[variant].size} tone={VALUE_TEXT[variant].tone} className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</Text>
 285 |           <Icon glyph={IconChevronDown} role="small" className="flex-none text-[var(--text-muted)]" />
 286 |         </button>
 287 |       </Tooltip>
 288 |       <AnimOut open={open && pos !== null} suppress="popover" scopeRef={menuRef}>
 289 |         {open && pos && (
 290 |           <div
 291 |             ref={menuRef}
```

### `ui/src/renderer/src/components/ui/Select.tsx:282`

```tsx
 282 |         >
 283 |           {prefix && <Text as="span" size={VALUE_TEXT[variant].size} className="flex-none inline-flex items-center">{prefix}</Text>}
 284 |           <Text as="span" size={VALUE_TEXT[variant].size} tone={VALUE_TEXT[variant].tone} className="min-w-0 flex-1 truncate text-left">{selected?.label ?? ''}</Text>
 285 |           <Icon glyph={IconChevronDown} role="small" className="flex-none text-[var(--text-muted)]" />
 286 |         </button>
 287 |       </Tooltip>
 288 |       <AnimOut open={open && pos !== null} suppress="popover" scopeRef={menuRef}>
 289 |         {open && pos && (
 290 |           <div
 291 |             ref={menuRef}
 292 |             id={listboxId}
```

### `ui/src/renderer/src/components/ui/Select.tsx:294`

```tsx
 294 |             data-testid={testId ? `${testId}-menu` : undefined}
 295 |             aria-label={ariaLabel}
 296 |             {...OVERLAY_RAISED_ATTRS}
 297 |             className={`${OVERLAY_RAISED_CLS} fixed z-[var(--z-dropdown)] flex flex-col p-1 overflow-y-auto overscroll-contain`}
 298 |             style={{
 299 |               left: pos.left,
 300 |               top: pos.top,
 301 |               bottom: pos.bottom,
 302 |               minWidth: pos.width,
 303 |               maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
 304 |               maxHeight: pos.maxHeight
```

### `ui/src/renderer/src/components/ui/Select.tsx:318`

```tsx
 318 |                     aria-disabled={o.disabled || undefined}
 319 |                     onMouseEnter={() => !o.disabled && setActive(i)}
 320 |                     onMouseUp={() => commit(i)}
 321 |                     className={`flex items-center gap-[var(--space-2)] min-h-[var(--h-ctl)] px-[var(--space-2)] rounded-[var(--tr-radius-sm)] cursor-pointer text-[length:var(--tr-text-ui-size)] ${
 322 |                       o.disabled
 323 |                         ? 'opacity-45 cursor-not-allowed text-[var(--text-muted)]'
 324 |                         : i === active
 325 |                           ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
 326 |                           : 'text-[var(--text-secondary)]'
 327 |                     }`}
 328 |                   >
```

### `ui/src/renderer/src/components/ui/Select.tsx:327`

```tsx
 327 |                     }`}
 328 |                   >
 329 |                     {}
 330 |                     <span className="flex-none w-[12px]">
 331 |                       {isSelected && <Icon glyph={IconCheck} role="small" />}
 332 |                     </span>
 333 |                     <span className="min-w-0 flex-1 truncate">{o.label}</span>
 334 |                   </div>
 335 |                 </Tooltip>
 336 |               )
 337 |             })}
```

### `ui/src/renderer/src/components/ui/Select.tsx:330`

```tsx
 330 |                     <span className="flex-none w-[12px]">
 331 |                       {isSelected && <Icon glyph={IconCheck} role="small" />}
 332 |                     </span>
 333 |                     <span className="min-w-0 flex-1 truncate">{o.label}</span>
 334 |                   </div>
 335 |                 </Tooltip>
 336 |               )
 337 |             })}
 338 |           </div>
 339 |         )}
 340 |       </AnimOut>
```

### `ui/src/renderer/src/components/ui/selectChrome.ts:1`

```tsx
   1 | export const SELECT_CLS =
   2 |   'h-[var(--h-ctl)] px-[var(--space-2)] bg-[var(--content-bg)] border border-[var(--border)] ' +
   3 |   'rounded-[var(--tr-radius-sm)] text-[var(--text-primary)] ' +
   4 |   'text-[length:var(--tr-text-ui-size)] font-medium ' +
   5 |   'disabled:opacity-45 disabled:cursor-not-allowed'
   6 | 
   7 | // A property chip in a record header: a hairline-bordered pill that carries its
   8 | // own label as a prefix. `!` on the gap and border keeps the trigger layout's
   9 | // gap and the open-state border from outranking the chip's own values.
```

### `ui/src/renderer/src/components/ui/Menu.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, ReactNode } from 'react'
   2 | import './floatingSurface.css'
   3 | 
   4 | export function GitToolMenuSurface({ children }: { children: ReactNode }): React.JSX.Element {
   5 |   return <div role="menu" data-testid="git-tools-items" className="absolute right-0 top-[calc(100%+4px)] z-[var(--z-sticky)] min-w-[190px] flex flex-col floating-glass floating-pop-in py-1 [transform-origin:right_top]">{children}</div>
   6 | }
   7 | 
   8 | /** The Git tools items without their floating surface, for hosts that already provide one. */
   9 | export function GitToolMenuSection({ children }: { children: ReactNode }): React.JSX.Element {
  10 |   return <div role="menu" data-testid="git-tools-items" className="min-w-[190px] flex flex-col">{children}</div>
  11 | }
  12 | 
  13 | export function GitToolMenuItem({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  14 |   return <button {...props} type="button" role="menuitem" className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-[length:var(--tr-text-sm)] bg-transparent border-0 text-[var(--text-secondary)] enabled:hover:bg-[var(--card-hover)] disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap">{children}</button>
  15 | }
  16 | 
  17 | export function GitToolMenuSeparator(): React.JSX.Element {
  18 |   return <div className="my-1 h-px bg-[var(--divider)]" role="separator" />
  19 | }
```

### `ui/src/renderer/src/components/ui/ContextMenu.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
   2 | import './floatingSurface.css'
   3 | import { Text } from './Text'
   4 | 
   5 | const EDITOR_MENU_CLASS = 'ctx-menu fixed z-[var(--z-overlay)] min-w-[var(--w-editor-context-menu)] flex flex-col p-1 floating-glass floating-pop-in [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)]'
   6 | const EDITOR_ITEM_CLASS = 'btn ctx-item border-none flex w-full items-center justify-between gap-[var(--space-editor-menu-gap)] rounded-[var(--tr-radius-input)] bg-transparent py-[var(--space-editor-menu-y)] px-2.5 text-left text-[var(--text-secondary)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'
   7 | 
   8 | const MENU_CLASS =
   9 |   'ctxmenu floating-glass floating-pop-in fixed z-[var(--z-context)] w-[var(--w-context-menu)] overflow-hidden flex flex-col [transform-origin:var(--pop-origin-x,center)_var(--pop-origin-y,center)] [&_.ctx-item]:grid [&_.ctx-item]:grid-cols-[var(--space-context-menu-icon-column)_minmax(0,1fr)_auto] [&_.ctx-item]:items-center [&_.ctx-item]:gap-[var(--space-1-5)] [&_.ctx-item]:w-full [&_.ctx-item]:h-[var(--h-context-menu-item)] [&_.ctx-item]:px-[var(--space-menu-item-x)] [&_.ctx-item]:py-0 [&_.ctx-item]:border-none [&_.ctx-item]:rounded-[var(--tr-radius-sm)] [&_.ctx-item]:bg-transparent [&_.ctx-item]:text-[var(--text-primary)] [&_.ctx-item]:[font-size:var(--tr-text-label-size)] [&_.ctx-item]:font-normal [&_.ctx-item]:text-left [&_.ctx-item:hover]:bg-[var(--card-hover)] [&_.ctx-item:hover]:text-[var(--text-primary)] [&_.ctx-item:focus-visible]:bg-[var(--card-hover)] [&_.ctx-item:focus-visible]:text-[var(--text-primary)] [&_.ctx-item:focus-visible]:outline-none [&_.ctx-item:disabled]:text-[var(--text-faint)] [&_.ctx-item:disabled]:cursor-default [&_.ctx-item:disabled]:opacity-[var(--opacity-context-menu-disabled)] [&_.ctx-item_kbd]:text-[var(--text-faint)] [&_.ctx-item_kbd]:font-mono [&_.ctx-item_kbd]:[font-size:var(--tr-text-label-size)] [&_.ctx-item_kbd]:font-medium [&_.ctx-item>svg:first-child]:justify-self-center [&_.ctx-sep]:h-px [&_.ctx-sep]:bg-[var(--border)] [&_.ctx-sep]:my-[var(--space-context-menu-separator-y)] [&_.ctx-sep]:mx-0 [&_.ctx-sep]:flex-none [&_.ctx-item.danger]:text-[color-mix(in_srgb,var(--danger)_80%,transparent)] [&_.ctx-item.danger:hover]:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] [&_.ctx-item.danger:hover]:text-[var(--danger)]'
  10 | 
  11 | export function ContextMenu({ children, className = '', ref, variant = 'default', ...props }: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement>; variant?: 'default' | 'editor' | 'grid-card' }): React.JSX.Element {
  12 |   const base = variant === 'editor' ? EDITOR_MENU_CLASS : `${MENU_CLASS} ${variant === 'grid-card' ? 'grid-card-menu' : ''}`
  13 |   return <div {...props} ref={ref} className={`${base} ${className}`}>{children}</div>
  14 | }
  15 | 
  16 | export function ContextMenuGridLabel({ children }: { children: ReactNode }): React.JSX.Element {
  17 |   return <div className="grid-card-menu-label truncate">{children}</div>
  18 | }
  19 | 
  20 | export function ContextMenuItems({ children }: { children: ReactNode }): React.JSX.Element {
  21 |   return <div className="flex flex-col gap-[var(--space-context-menu-gap)] p-[var(--space-context-menu-pad)]">{children}</div>
  22 | }
  23 | 
  24 | export function ContextMenuItem({ danger = false, variant = 'default', shortcut, children, ref, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean; variant?: 'default' | 'editor'; shortcut?: string; ref?: Ref<HTMLButtonElement> }): React.JSX.Element {
  25 |   if (variant === 'editor') return <button {...props} ref={ref} type={props.type} className={`${EDITOR_ITEM_CLASS} ${props.className ?? ''}`}>{shortcut ? <><Text as="span" size="small" weight="small">{children}</Text><Text as="span" size="small" weight="small" tone="faint">{shortcut}</Text></> : children}</button>
  26 |   return <button {...props} ref={ref} type="button" className={`btn ctx-item ${danger ? 'danger' : ''} ${props.className ?? ''}`}>{children}</button>
  27 | }
  28 | 
  29 | export function ContextMenuHeading({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element {
  30 |   return (
  31 |     <div className="flex flex-col justify-center gap-[var(--space-context-menu-title-gap)] min-h-[var(--h-context-menu-title)] px-[var(--space-context-menu-title-x)] py-[var(--space-context-menu-title-y)] border-b border-[var(--divider)]">
  32 |       <strong className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-context-menu-heading-weight)] text-[var(--text-primary)]">{title}</strong>
  33 |       <small className="block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]">{subtitle}</small>
  34 |     </div>
  35 |   )
  36 | }
  37 | 
  38 | export function ContextMenuSeparator({ variant = 'default', ...props }: HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'editor' }): React.JSX.Element {
  39 |   if (variant === 'editor') return <div className="ctx-sep h-px flex-none bg-[var(--border)] my-1 mx-1.5" />
  40 |   return <div {...props} className={`ctx-sep ${props.className ?? ''}`} />
  41 | }
  42 | 
  43 | export function ContextMenuSectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  44 |   return <div role="presentation" className="px-[var(--space-context-menu-section-x)] pt-[var(--space-context-menu-section-top)] pb-[var(--space-context-menu-section-bottom)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[var(--tr-text-label-tracking)] text-[var(--text-faint)]">{children}</div>
  45 | }
  46 | 
  47 | export function ContextMenuMessage({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  48 |   return <div className={`px-[var(--space-menu-item-x)] py-[var(--space-1-5)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)] ${className}`}>{children}</div>
  49 | }
  50 | 
  51 | export function ContextMenuColorDot({ color, size = 'tag' }: { color: string; size?: 'tag' | 'filter' }): React.JSX.Element {
  52 |   const metric = size === 'tag' ? '--space-context-menu-tag-dot' : '--space-context-menu-filter-dot'
  53 |   return <span aria-hidden className="rounded-full justify-self-center" style={{ width: `var(${metric})`, height: `var(${metric})`, background: color }} />
  54 | }
  55 | 
```

### `ui/src/renderer/src/components/ui/KeyCap.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
   2 | import { Text } from './Text'
   3 | 
   4 | export function KeyCap({ children }: { children: ReactNode }): React.JSX.Element {
   5 |   return (
   6 |     <span className="inline-flex min-w-[var(--w-shortcut-keycap)] justify-center rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-keycap-inline)] py-[var(--space-keycap-block)]">
   7 |       <Text size="small" weight="semibold" tone="muted" center>{children}</Text>
   8 |     </span>
   9 |   )
  10 | }
  11 | 
  12 | export function KeyBindingRow({ keyName, description, disabled = false }: { keyName: string; description: string; disabled?: boolean }): React.JSX.Element {
  13 |   return (
  14 |     <div className={`flex items-baseline gap-[var(--space-2-5)] ${disabled ? 'opacity-[var(--opacity-inactive)]' : ''}`}>
  15 |       <KeyCap>{keyName}</KeyCap>
  16 |       <Text size="caption" weight="label" tone="secondary">{description}</Text>
  17 |     </div>
  18 |   )
  19 | }
  20 | 
```

### `ui/src/renderer/src/components/ui/ShortcutHint.tsx:1`

```tsx
   1 | import type { ReactNode } from 'react'
   2 | import { Text } from './Text'
   3 | 
   4 | /** A key in a launcher shortcut hint; `compact` is the rail's search-field hint. */
   5 | export function HintKey({ children, size = 'default' }: { children: ReactNode; size?: 'default' | 'compact' }): React.JSX.Element {
   6 |   return <kbd className={size === 'compact' ? 'inline-flex h-[18px] min-w-[var(--w-rail-keycap-min)] items-center justify-center rounded-[var(--tr-radius-input)] bg-hover-fill px-[var(--space-rail-keycap-x)] font-sans [font-size:var(--tr-text-xs)] font-medium leading-none text-[var(--text-muted)]' : 'font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] bg-background border border-border rounded-[var(--tr-radius-input)] py-[var(--space-keycap-y)] px-[var(--space-keycap-x)]'}>{children}</kbd>
   7 | }
   8 | 
   9 | export function ShortcutHint({ shortcut, label, disabled = false }: { shortcut: string; label: string; disabled?: boolean }): React.JSX.Element {
  10 |   return <span className={`flex items-center gap-[var(--space-menu-item-x)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-text-muted ${disabled ? 'opacity-[var(--opacity-shortcuts-disabled)]' : ''}`}><HintKey>{shortcut}</HintKey>{label}</span>
  11 | }
  12 | 
  13 | export function ShortcutHintFooter({ children, disabledMessage, disabled = false }: { children: ReactNode; disabledMessage?: string; disabled?: boolean }): React.JSX.Element {
  14 |   return <div className="flex w-full max-w-[var(--w-shortcut-hint-footer)] flex-col items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] pt-[var(--space-4)]" data-testid="launcher-hint-footer"><div className={`flex flex-wrap items-center justify-center gap-x-[var(--space-4-5)] gap-y-[var(--space-1-5)] ${disabled ? 'opacity-[var(--opacity-shortcuts-disabled)]' : ''}`}>{children}</div>{disabledMessage && <Text as="p" flush size="small" weight="small" tone="muted" data-testid="launcher-hints-off">{disabledMessage}</Text>}</div>
  15 | }
  16 | 
```

### `ui/src/renderer/src/components/ui/Chip.tsx:1`

```tsx
   1 | import { IconClose } from '../icons'
   2 | import { FOCUS_HALO } from './shadowChrome'
   3 | import { HIT_TARGET_28 } from '../hitTarget'
   4 | import { Icon } from './Icon'
   5 | import { Tooltip } from './Tooltip'
   6 | 
   7 | export type ChipVariant = 'state' | 'provider' | 'count' | 'compound' | 'removable' | 'choice'
   8 | export type ChipTone = 'default' | 'info' | 'success' | 'warning' | 'danger'
   9 | 
  10 | export interface ChipProps {
  11 |   variant: ChipVariant
  12 |   label?: string
  13 |   tone?: ChipTone
  14 |   icon?: React.ReactNode
  15 |   count?: number
  16 |   emptySetLabel?: string
  17 |   selected?: boolean
  18 |   disabled?: boolean
  19 |   disabledReason?: string
  20 |   loading?: boolean
  21 |   onClick?: () => void
  22 |   onRemove?: () => void
  23 |   className?: string
  24 | }
  25 | 
  26 | export function ChoiceGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  27 |   return <div className="flex flex-wrap gap-[var(--space-2)]">{children}</div>
  28 | }
  29 | 
  30 | const TONE_CLASS: Record<ChipTone, string> = {
  31 |   default: 'bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border)]',
  32 |   info: 'bg-[var(--status-doing-bg)] text-[var(--status-doing-text)] border-transparent',
  33 |   success: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)] border-transparent',
  34 |   warning: 'bg-[var(--status-todo-bg)] text-[var(--status-todo-text)] border-transparent',
  35 |   danger: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] border-transparent'
  36 | }
  37 | 
  38 | function Spinner({ size = 10 }: { size?: number }): React.JSX.Element {
  39 |   return (
  40 |     <span
  41 |       role="status"
  42 |       aria-label="Loading"
  43 |       className="inline-block flex-none animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
  44 |       style={{ width: size, height: size }}
  45 |     />
  46 |   )
  47 | }
  48 | 
  49 | // `undefined` is "not fetched yet", `0` is a fetched, known-zero tally — the two
  50 | // must not look identical, so 0 renders `emptySetLabel` rather than "0".
  51 | function CountContent({ loading, count, emptySetLabel }: Pick<ChipProps, 'loading' | 'count' | 'emptySetLabel'>): React.JSX.Element {
  52 |   if (loading) return <Spinner />
  53 |   if (count === undefined) return <span data-testid="chip-empty">–</span>
  54 |   if (count === 0) return <span data-testid="chip-empty-set">{emptySetLabel}</span>
  55 |   return <span className="tabular-nums">{count}</span>
  56 | }
  57 | 
  58 | function choiceClass(selected: boolean): string {
  59 |   return `btn min-h-[var(--h-ctl)] px-[var(--space-choice-x)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-pointer disabled:cursor-default disabled:opacity-60 ${selected ? 'bg-[var(--selected-fill)] font-semibold text-[var(--text-primary)]' : 'bg-[var(--hover-fill)] font-medium text-[var(--text-secondary)] hover:not-disabled:bg-[var(--selected-fill)] hover:not-disabled:text-[var(--text-primary)]'}`
  60 | }
  61 | 
  62 | function pillClass(tone: ChipTone, isPressable: boolean, selected: boolean): string {
  63 |   const shapeRadius = isPressable ? 'rounded-[var(--tr-radius-pill)]' : 'rounded-[var(--tr-radius-sm)]'
  64 |   const press = isPressable ? 'cursor-pointer hover:bg-[var(--surface-hover)] active:scale-[0.96]' : ''
  65 |   const pressed = selected ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--text-primary)]' : ''
  66 |   return `inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] max-w-full px-[var(--space-2)] border text-[length:var(--tr-text-small-size)] font-medium leading-[var(--tr-text-small-leading)] ${shapeRadius} ${TONE_CLASS[tone]} ${press} ${pressed}`
  67 | }
  68 | 
  69 | function chipClass({ variant, tone, selected, disabled, isPressable }: { variant: ChipVariant; tone: ChipTone; selected: boolean; disabled: boolean; isPressable: boolean }): string {
  70 |   const shape = variant === 'choice' ? choiceClass(selected) : pillClass(tone, isPressable, selected)
  71 |   return `${shape} ${disabled ? 'opacity-50 cursor-not-allowed' : ''} focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}]`
  72 | }
  73 | 
  74 | export function Chip({
  75 |   variant,
  76 |   label,
  77 |   tone = 'default',
  78 |   icon,
  79 |   count,
  80 |   emptySetLabel = 'None',
  81 |   selected = false,
  82 |   disabled = false,
  83 |   disabledReason,
  84 |   loading = false,
  85 |   onClick,
  86 |   onRemove,
  87 |   className = ''
  88 | }: ChipProps): React.JSX.Element {
  89 |   const isPressable = variant === 'removable' || !!onClick
  90 | 
  91 |   const content = variant === 'count' ? <CountContent loading={loading} count={count} emptySetLabel={emptySetLabel} /> : label
  92 | 
  93 |   const Tag = isPressable ? 'button' : 'div'
  94 |   const removeLabel = `Remove ${label ?? 'item'}`
  95 |   const tooltipLabel = disabled
  96 |     ? disabledReason
  97 |     : label && label.length > 24
  98 |       ? label
  99 |       : undefined
 100 | 
 101 |   return (
 102 |     <Tooltip label={tooltipLabel} className={isPressable && disabled ? 'inline-flex' : undefined}>
 103 |       <Tag
 104 |         type={isPressable ? 'button' : undefined}
 105 |         data-testid="chip"
 106 |         data-variant={variant}
 107 |         aria-disabled={disabled || undefined}
 108 |         aria-pressed={isPressable ? selected : undefined}
 109 |         disabled={isPressable ? disabled : undefined}
 110 |         onClick={isPressable && !disabled ? onClick : undefined}
 111 |         className={`${chipClass({ variant, tone, selected, disabled, isPressable })} ${className}`}
 112 |       >
 113 |         {icon && <span aria-hidden className="flex-none">{icon}</span>}
 114 |         <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{content}</span>
 115 |         {variant === 'removable' && (
 116 |           <Tooltip label={disabled ? disabledReason : removeLabel} className="inline-flex">
 117 |             <button
 118 |               type="button"
 119 |               aria-label={removeLabel}
 120 |               disabled={disabled}
 121 |               onClick={(e) => {
 122 |                 e.stopPropagation()
 123 |                 onRemove?.()
 124 |               }}
 125 |               className={`border-0 bg-transparent flex-none inline-flex items-center justify-center h-[var(--h-chip-dismiss)] w-[var(--h-chip-dismiss)] rounded-full hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed ${HIT_TARGET_28}`}
 126 |             >
 127 |               <Icon glyph={IconClose} role="label" />
 128 |             </button>
 129 |           </Tooltip>
 130 |         )}
 131 |       </Tag>
 132 |     </Tooltip>
 133 |   )
 134 | }
```

### `ui/src/renderer/src/components/ui/StatusLabel.tsx:1`

```tsx
   1 | export const STATUS_LABELS = [
   2 |   'Working',
   3 |   'Needs input',
   4 |   'Idle',
   5 |   'Done',
   6 |   'Ended',
   7 |   'Failed',
   8 |   'Paused',
   9 |   'Stalled',
  10 |   'Result staged',
  11 |   'Pending delivery',
  12 |   'In sync',
  13 |   'Waiting for a slot',
  14 |   'Differs',
  15 |   'Off',
  16 |   'Connected',
  17 |   'Reconnecting',
  18 |   'Missing',
  19 |   'Open',
  20 |   'Fixing',
  21 |   'Not seen',
  22 |   'Ready',
  23 |   'Stale',
  24 |   'Kept',
  25 |   'Watching',
  26 |   'Verified'
  27 | ] as const
  28 | 
  29 | export type StatusLabelValue = (typeof STATUS_LABELS)[number]
  30 | 
  31 | const STATUS_DOT: Record<StatusLabelValue, string> = {
  32 |   Working: 'var(--info)',
  33 |   'Needs input': 'var(--warn)',
  34 |   Idle: 'var(--text-faint)',
  35 |   Done: 'var(--ok)',
  36 |   Ended: 'var(--info)',
  37 |   Failed: 'var(--stop)',
  38 |   Paused: 'var(--text-muted)',
  39 |   Stalled: 'var(--text-muted)',
  40 |   'Result staged': 'var(--info)',
  41 |   'Pending delivery': 'var(--info)',
  42 |   'In sync': 'var(--ok)',
  43 |   'Waiting for a slot': 'var(--warn)',
  44 |   Differs: 'var(--warn)',
  45 |   Off: 'var(--text-faint)',
  46 |   Connected: 'var(--ok)',
  47 |   Reconnecting: 'var(--warn)',
  48 |   Missing: 'var(--text-faint)',
  49 |   Open: 'var(--warn)',
  50 |   Fixing: 'var(--info)',
  51 |   'Not seen': 'var(--text-faint)',
  52 |   Ready: 'var(--ok)',
  53 |   Stale: 'var(--warn)',
  54 |   Kept: 'var(--text-faint)',
  55 |   Watching: 'var(--info)',
  56 |   Verified: 'var(--ok)'
  57 | }
  58 | 
  59 | const STATUS_TEXT: Partial<Record<StatusLabelValue, string>> = {
  60 |   Off: 'text-[var(--text-muted)]'
  61 | }
  62 | 
  63 | type PillTone = 'waiting' | 'failed' | 'done' | 'working' | 'unknown'
  64 | 
  65 | const PILL_CLASS = 'inline-flex items-center h-[17px] px-2 rounded-[var(--tr-radius-sm)] flex-none [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase'
  66 | const PILL_TONE: Record<PillTone, string> = {
  67 |   waiting: 'bg-[var(--status-todo-bg)] text-[var(--status-todo-text)]',
  68 |   failed: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)]',
  69 |   done: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)]',
  70 |   working: 'bg-[var(--status-doing-bg)] text-[var(--status-doing-text)]',
  71 |   unknown: 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-muted)]'
  72 | }
  73 | 
  74 | export function StatusLabel({ status, size = 'ui', variant = 'default', tone = 'unknown', children }: { status: StatusLabelValue; size?: 'ui' | 'small'; variant?: 'default' | 'pill' | 'dot'; tone?: PillTone; children?: React.ReactNode }): React.JSX.Element {
  75 |   if (variant === 'pill') return <span className={`${PILL_CLASS} ${PILL_TONE[tone]}`}>{children ?? status}</span>
  76 |   const hollow = status === 'Idle' || status === 'Paused' || status === 'Missing' || status === 'Not seen' || status === 'Off' || status === 'Kept'
  77 |   return (
  78 |     <span role={variant === 'dot' ? 'img' : undefined} aria-label={status} className={`inline-flex items-center gap-[var(--space-1-5)] text-[var(--text-secondary)] ${STATUS_TEXT[status] ?? ''} ${size === 'small' ? 'text-[length:var(--tr-text-small-size)]' : ''}`}>
  79 |       <span
  80 |         aria-hidden="true"
  81 |         className="agent-dot h-[var(--space-1-5)] w-[var(--space-1-5)] flex-none rounded-full"
  82 |         style={hollow
  83 |           ? { backgroundColor: 'transparent', border: '1px solid var(--text-faint)' }
  84 |           : { backgroundColor: STATUS_DOT[status] }}
  85 |       />
  86 |       {variant === 'default' && status}
  87 |     </span>
  88 |   )
  89 | }
```

### `ui/src/renderer/src/components/ui/Tooltip.tsx:1`

```tsx
   1 | import { createContext, useCallback, useEffect, useId, useRef, useState } from 'react'
   2 | import { createPortal } from 'react-dom'
   3 | import './floatingSurface.css'
   4 | 
   5 | // Hover is delayed, keyboard focus is not: a tabbed-to control already committed
   6 | // intent, a hovered one has not.
   7 | export const HOVER_DELAY_MS = 400
   8 | 
   9 | const OFFSET_PX = 6
  10 | 
  11 | const VIEWPORT_MARGIN_PX = 4
  12 | 
  13 | export const TooltipContext = createContext<string | null>(null)
  14 | 
  15 | interface Props {
  16 |   label?: string | null
  17 |   side?: 'top' | 'bottom'
  18 |   className?: string
  19 |   inline?: boolean
  20 |   openOnClick?: boolean
  21 |   children: React.ReactNode
  22 | }
  23 | 
  24 | interface Placement {
  25 |   top: number
  26 |   left: number
  27 | }
  28 | 
```

### `ui/src/renderer/src/components/ui/Tooltip.tsx:140`

```tsx
 140 |         label &&
 141 |         createPortal(
 142 |           <div
 143 |             ref={bubbleRef}
 144 |             id={id}
 145 |             role="tooltip"
 146 |             style={{
 147 |               top: place?.top ?? 0,
 148 |               left: place?.left ?? 0,
 149 |               visibility: place ? 'visible' : 'hidden'
 150 |             }}
 151 |             className="floating-glass floating-pop-in fixed z-[var(--z-tooltip)] pointer-events-none max-w-[280px] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.35] py-[4px] px-[7px] whitespace-pre-line"
 152 |           >
 153 |             {label}
 154 |           </div>,
 155 |           document.body
 156 |         )}
 157 |     </span></TooltipContext.Provider>
 158 |   )
 159 | }
```

### `ui/src/renderer/src/components/ui/floatingSurface.css:1`

```tsx
   1 | .floating-glass {
   2 |   background: var(--glass-bg) !important;
   3 |   backdrop-filter: blur(16px) saturate(1.08) !important;
   4 |   -webkit-backdrop-filter: blur(16px) saturate(1.08) !important;
   5 |   border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent) !important;
   6 |   border-radius: var(--tr-radius-md) !important;
   7 |   box-shadow: 0 18px 44px -18px #000c !important;
   8 | }
   9 | 
  10 | @keyframes floating-pop-in {
  11 |   from { opacity: 0; transform: scale(.98); }
  12 | }
  13 | 
  14 | @keyframes floating-pop-out {
  15 |   to { opacity: 0; transform: scale(.98); }
  16 | }
  17 | 
  18 | @keyframes floating-view-forward {
  19 |   from { opacity: 0; transform: translateX(8px); }
  20 | }
  21 | 
  22 | @keyframes floating-view-back {
  23 |   from { opacity: 0; transform: translateX(-8px); }
  24 | }
  25 | 
  26 | @keyframes floating-highlight {
  27 |   0%, 30% { background: color-mix(in srgb, var(--accent) 15%, transparent); }
  28 |   to { background: transparent; }
  29 | }
  30 | 
  31 | .floating-pop-in { animation: floating-pop-in 150ms var(--motion-menu-ease); }
  32 | .anim-out .floating-pop-in { animation: floating-pop-out 150ms var(--motion-menu-ease) forwards; }
  33 | .grid-hover-card { opacity: 0; transform: scale(.98); pointer-events: none; }
  34 | .grid-hover-card[data-visible='true'] { opacity: 1; transform: none; }
  35 | .grid-card-menu { width: 208px !important; }
  36 | .grid-card-menu > .grid-card-menu-label {
  37 |   margin-top: var(--space-1);
  38 |   padding: var(--space-1-5) var(--space-2) var(--space-1);
  39 |   color: var(--text-muted);
  40 |   font-size: var(--tr-text-label-size);
  41 |   font-weight: 500;
  42 | }
  43 | .grid-card-menu > div:last-child { gap: 0; padding: var(--space-1); }
  44 | .grid-card-menu .ctx-item {
  45 |   display: flex !important;
  46 |   align-items: center;
  47 |   gap: var(--space-2) !important;
  48 |   width: 100%;
  49 |   min-height: 28px;
  50 |   height: auto !important;
  51 |   padding: var(--space-1) var(--space-2) !important;
  52 |   color: var(--text-primary);
  53 |   font-size: var(--tr-text-ui-size);
  54 | }
  55 | .grid-card-menu .ctx-item > svg:first-child { color: var(--text-muted); opacity: .85; }
  56 | .grid-card-menu .ctx-item > svg:last-child { margin-left: auto; color: var(--text-muted); }
  57 | .grid-card-menu .ctx-item.danger { color: var(--stop) !important; }
  58 | .grid-card-menu .ctx-item.danger > svg:first-child { color: var(--stop); opacity: 1; }
  59 | .grid-card-menu .ctx-sep { margin: var(--space-1) var(--space-2) !important; background: var(--divider) !important; }
  60 | 
  61 | @media (prefers-reduced-motion: reduce) {
  62 |   .floating-pop-in { animation: none; }
  63 |   .anim-out .floating-pop-in { animation: none; }
  64 | }
```

### `ui/src/renderer/src/components/ui/panel.css:1`

```tsx
   1 | .side-panel-header {
   2 |   height: 34px;
   3 |   min-height: 34px;
   4 |   display: flex;
   5 |   align-items: center;
   6 |   gap: var(--space-1);
   7 |   padding: 0 var(--space-1-5) 0 var(--space-2);
   8 |   border-bottom: 1px solid var(--divider);
   9 | }
  10 | .side-panel-tabs {
  11 |   display: flex;
  12 |   min-width: 0;
  13 |   flex: 1;
  14 |   align-items: center;
  15 |   gap: var(--space-0-5);
  16 |   overflow: hidden;
  17 | }
  18 | .side-panel-tabs.is-overflowing {
  19 |   -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
  20 |   mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent);
  21 | }
  22 | .side-panel-header-actions {
  23 |   display: flex;
  24 |   align-items: center;
  25 |   gap: var(--space-0-5);
  26 |   margin-left: auto;
  27 | }
  28 | .panel-tab {
  29 |   display: inline-flex;
  30 |   flex: none;
  31 |   align-items: center;
  32 |   gap: var(--space-0-5);
  33 |   height: 24px;
  34 |   max-width: 144px;
  35 |   padding: 0 var(--space-2) 0 var(--space-1);
  36 |   border: 0;
  37 |   border-radius: var(--tr-radius-sm);
  38 |   background: transparent;
  39 |   color: var(--text-muted);
  40 |   font: inherit;
  41 |   font-size: var(--tr-text-sm);
  42 |   white-space: nowrap;
  43 |   cursor: pointer;
  44 |   transition:
  45 |     background-color 0.15s,
  46 |     color 0.15s;
  47 | }
  48 | .panel-tab:hover {
  49 |   background: var(--hover-fill);
  50 |   color: var(--text-primary);
  51 | }
  52 | .panel-tab[aria-selected="true"] {
  53 |   background: var(--hover-strong);
  54 |   color: var(--text-primary);
  55 | }
  56 | .panel-tab-icon {
  57 |   position: relative;
  58 |   display: inline-flex;
  59 |   width: 16px;
  60 |   height: 16px;
  61 |   flex: none;
  62 |   align-items: center;
  63 |   justify-content: center;
  64 |   border-radius: var(--tr-radius-input);
  65 | }
  66 | .panel-tab-close {
  67 |   display: none;
  68 | }
  69 | .panel-tab:hover .panel-tab-glyph {
  70 |   display: none;
  71 | }
  72 | .panel-tab:hover .panel-tab-close {
  73 |   display: inline-flex;
  74 | }
  75 | .panel-tab-label {
  76 |   min-width: 0;
  77 |   overflow: hidden;
  78 |   text-overflow: ellipsis;
  79 | }
  80 | .panel-tab-pr-icon {
  81 |   display: inline-flex;
  82 |   color: var(--ok);
  83 | }
  84 | .panel-tab-pr-icon.is-warn { color: var(--warn); }
  85 | .panel-tab-pr-icon.is-stop { color: var(--stop); }
  86 | .side-panel-icon-button {
  87 |   display: inline-flex;
  88 |   width: 24px;
  89 |   height: 24px;
  90 |   flex: none;
  91 |   align-items: center;
  92 |   justify-content: center;
  93 |   padding: 0;
  94 |   border: 0;
  95 |   border-radius: var(--tr-radius-sm);
  96 |   background: transparent;
  97 |   color: var(--text-muted);
  98 |   cursor: pointer;
  99 | }
 100 | .side-panel-icon-button:hover {
 101 |   background: var(--hover-fill);
 102 |   color: var(--text-primary);
 103 | }
 104 | .side-panel-icon-button:active {
 105 |   transform: scale(0.97);
 106 | }
 107 | .side-panel-launcher {
 108 |   display: flex;
 109 |   flex: 1;
 110 |   align-items: center;
 111 |   justify-content: center;
 112 |   padding: var(--space-5) var(--space-5) var(--space-panel-empty-bottom);
 113 |   outline: none;
 114 | }
 115 | .side-panel-launcher-column {
 116 |   width: 100%;
 117 |   max-width: 300px;
 118 | }
 119 | .side-panel-launcher .panel-launcher-description {
 120 |   display: none;
 121 | }
 122 | .side-panel-launcher-title {
 123 |   margin: 0 0 var(--space-3);
 124 |   text-align: center;
 125 |   color: var(--text-primary);
 126 |   font-size: var(--tr-text-panel-launcher);
 127 |   font-weight: 500;
 128 | }
 129 | .side-panel-launcher-rows {
 130 |   display: flex;
 131 |   flex-direction: column;
 132 |   gap: var(--space-0-5);
 133 | }
 134 | .panel-launcher-row {
 135 |   display: flex;
 136 |   width: 100%;
 137 |   height: 32px;
 138 |   align-items: center;
 139 |   gap: var(--space-3);
 140 |   padding: 0 var(--space-2-5);
 141 |   border: 0;
 142 |   border-radius: var(--tr-radius-button);
 143 |   background: transparent;
 144 |   color: var(--text-primary);
 145 |   text-align: left;
 146 |   font: inherit;
 147 |   font-size: var(--tr-text-panel-launcher);
 148 |   cursor: pointer;
 149 |   transition: background-color 0.15s;
 150 | }
 151 | .panel-launcher-row:hover,
 152 | .panel-launcher-row:focus-visible {
 153 |   background: var(--hover-fill);
 154 |   outline: none;
 155 | }
 156 | .panel-launcher-row.is-disabled {
 157 |   opacity: 0.5;
 158 |   cursor: default;
 159 | }
 160 | .panel-launcher-row.is-disabled:hover {
 161 |   background: transparent;
 162 | }
 163 | .panel-launcher-icon {
 164 |   display: inline-flex;
 165 |   width: 16px;
 166 |   flex: none;
 167 |   justify-content: center;
 168 |   color: var(--text-secondary);
 169 | }
 170 | .panel-launcher-copy {
 171 |   display: flex;
 172 |   min-width: 0;
 173 |   flex: 1;
 174 |   flex-direction: column;
 175 |   gap: var(--space-pixel);
 176 | }
 177 | .panel-launcher-label {
 178 |   line-height: 16px;
 179 | }
 180 | .panel-launcher-description {
 181 |   overflow: hidden;
 182 |   color: var(--text-muted);
 183 |   font-size: var(--tr-text-xs);
 184 |   line-height: 13px;
 185 |   text-overflow: ellipsis;
 186 |   white-space: nowrap;
 187 | }
 188 | .panel-launcher-key {
 189 |   display: inline-flex;
 190 |   height: 18px;
 191 |   min-width: 18px;
 192 |   align-items: center;
 193 |   justify-content: center;
 194 |   padding: 0 var(--space-1);
 195 |   border: 0;
 196 |   border-radius: var(--tr-radius-xs);
 197 |   background: var(--hover-fill);
 198 |   color: var(--text-muted);
 199 |   font: inherit;
 200 |   font-family: var(--font-sans);
 201 |   font-size: var(--tr-text-xs);
 202 |   font-weight: 500;
 203 | }
 204 | .side-panel-body {
 205 |   position: relative;
 206 |   display: flex;
 207 |   flex: 1;
 208 |   min-width: 0;
 209 |   min-height: 0;
 210 |   flex-direction: column;
 211 |   overflow: hidden;
 212 |   background: var(--content-bg);
 213 | }
 214 | .side-panel-overview {
 215 |   position: absolute;
 216 |   z-index: 20;
 217 |   inset: 0;
 218 |   display: flex;
 219 |   min-width: 0;
 220 |   min-height: 0;
 221 |   flex-direction: column;
 222 |   background: var(--content-bg);
 223 | }
 224 | .side-panel-surface {
 225 |   display: flex;
 226 |   position: absolute;
 227 |   inset: 0;
 228 |   min-width: 0;
 229 |   min-height: 0;
 230 |   flex-direction: column;
 231 |   overflow: hidden;
 232 | }
 233 | .side-panel-surface[hidden] {
 234 |   display: none;
 235 | }
 236 | .side-panel-linked-list {
 237 |   display: flex;
 238 |   min-height: 0;
 239 |   flex: 1;
 240 |   flex-direction: column;
 241 |   gap: var(--space-0-5);
 242 |   overflow: auto;
 243 |   padding: var(--space-3);
 244 | }
 245 | .side-panel-linked-row {
 246 |   display: flex;
 247 |   min-width: 0;
 248 |   align-items: center;
 249 |   gap: var(--space-2);
 250 |   padding: var(--space-2);
 251 |   border: 0;
 252 |   border-radius: var(--tr-radius-sm);
 253 |   background: transparent;
 254 |   color: var(--text-primary);
 255 |   text-align: left;
 256 |   cursor: pointer;
 257 | }
 258 | .side-panel-linked-row:hover {
 259 |   background: var(--hover-fill);
 260 | }
 261 | .side-panel-linked-copy {
 262 |   display: flex;
 263 |   min-width: 0;
 264 |   flex: 1;
 265 |   flex-direction: column;
 266 |   gap: var(--space-0-5);
 267 | }
 268 | .side-panel-linked-title {
 269 |   overflow: hidden;
 270 |   font-size: var(--tr-text-row);
 271 |   text-overflow: ellipsis;
 272 |   white-space: nowrap;
 273 | }
 274 | .side-panel-linked-meta {
 275 |   color: var(--text-muted);
 276 |   font-family: var(--font-mono);
 277 |   font-size: var(--tr-text-file-status);
 278 | }
 279 | .side-panel-empty {
 280 |   display: flex;
 281 |   flex: 1;
 282 |   align-items: center;
 283 |   justify-content: center;
 284 |   padding: var(--space-5);
 285 |   color: var(--text-muted);
 286 |   font-size: var(--tr-text-sm);
 287 |   text-align: center;
 288 | }
 289 | .panel-pr-check-popover {
 290 |   position: absolute;
 291 |   z-index: 50;
 292 |   top: calc(100% + 6px);
 293 |   right: 12px;
 294 |   max-width: calc(100vw - 24px);
 295 |   padding: var(--space-fullscreen-message);
 296 |   border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
 297 |   border-radius: var(--tr-radius-md);
 298 |   background: var(--glass-bg);
 299 |   backdrop-filter: blur(16px) saturate(1.08);
 300 |   -webkit-backdrop-filter: blur(16px) saturate(1.08);
 301 |   box-shadow: var(--shadow-panel-check-popover);
 302 |   transform-origin: top right;
 303 |   animation: panel-checks-pop-in 150ms var(--motion-menu-ease) both;
 304 | }
 305 | .panel-pr-check-popover [data-testid="pr-checks-list"] {
 306 |   max-height: min(55vh, 420px);
 307 |   overflow: auto;
 308 | }
 309 | .side-panel-add-menu {
 310 |   position: absolute;
 311 |   z-index: 50;
 312 |   top: 36px;
 313 |   right: 8px;
 314 |   min-width: 176px;
 315 |   padding: var(--space-1);
 316 |   border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
 317 |   border-radius: var(--tr-radius-md);
 318 |   background: var(--glass-bg);
 319 |   box-shadow: var(--shadow-1);
 320 |   backdrop-filter: blur(16px) saturate(1.08);
 321 |   -webkit-backdrop-filter: blur(16px) saturate(1.08);
 322 | }
 323 | .side-panel-add-item {
 324 |   display: flex;
 325 |   width: 100%;
 326 |   height: 28px;
 327 |   align-items: center;
 328 |   gap: var(--space-2);
 329 |   padding: 0 var(--space-2);
 330 |   border: 0;
 331 |   border-radius: var(--tr-radius-sm);
 332 |   background: transparent;
 333 |   color: var(--text-primary);
 334 |   text-align: left;
 335 |   font: inherit;
 336 |   font-size: var(--tr-text-sm);
 337 |   cursor: pointer;
 338 | }
 339 | .side-panel-add-item:hover {
 340 |   background: var(--hover-fill);
 341 | }
 342 | .side-panel-add-item.is-disabled {
 343 |   opacity: 0.5;
 344 |   cursor: default;
 345 | }
 346 | .side-panel-add-key {
 347 |   margin-left: auto;
 348 |   color: var(--text-muted);
 349 |   font-family: var(--font-sans);
 350 |   font-size: var(--tr-text-xs);
 351 |   font-weight: 500;
 352 |   min-width: 18px;
 353 |   height: 18px;
 354 |   display: inline-flex;
 355 |   align-items: center;
 356 |   justify-content: center;
 357 |   padding: 0 var(--space-1);
 358 |   border-radius: var(--tr-radius-xs);
 359 |   background: var(--hover-fill);
 360 | }
 361 | @keyframes panel-checks-pop-in {
 362 |   from {
 363 |     opacity: 0;
 364 |     transform: scale(0.98);
 365 |   }
 366 |   to {
 367 |     opacity: 1;
 368 |     transform: scale(1);
 369 |   }
 370 | }
 371 | .side-panel-surface [role="dialog"][aria-label="Pull request checks"] {
 372 |   transform-origin: top right;
 373 |   animation: panel-checks-pop-in 150ms var(--motion-menu-ease) both;
 374 | }
 375 | @media (prefers-reduced-motion: reduce) {
 376 |   .side-panel-surface [role="dialog"][aria-label="Pull request checks"] {
 377 |     animation: none;
 378 |   }
 379 | }
 380 | @media (prefers-reduced-motion: reduce) {
 381 |   .panel-tab,
 382 |   .panel-launcher-row {
 383 |     transition: none;
 384 |   }
 385 | }
```

### `ui/src/renderer/src/components/ui/PaneHeader.tsx:1`

```tsx
   1 | import type { HTMLAttributes, ReactNode } from 'react'
   2 | import { Text } from './Text'
   3 | import './paneFocus.css'
   4 | 
   5 | const DIVIDER = {
   6 |   solid: 'border-b-[var(--divider)]',
   7 |   borderMuted: 'border-b-[var(--pane-head-border-muted)]',
   8 |   dividerMuted: 'border-b-[var(--pane-head-divider-muted)]'
   9 | } as const
  10 | 
  11 | const TRANSITION = {
  12 |   background: '[transition:background_0.2s]',
  13 |   surface: '[transition:background_0.2s,border-color_0.2s]',
  14 |   browser: '[transition:background_0.2s,border-color_0.15s_ease]'
  15 | } as const
  16 | 
  17 | /** A draggable header row for a pane, with its focus surface supplied by PaneFocus. */
  18 | export function PaneHeader({ divider = 'solid', transition = 'background', inset = 'default', dragCursor = false, onPointerDown, children, ...props }: HTMLAttributes<HTMLElement> & {
  19 |   divider?: keyof typeof DIVIDER
  20 |   transition?: keyof typeof TRANSITION
  21 |   inset?: 'default' | 'compact'
  22 |   dragCursor?: boolean
  23 |   children: ReactNode
  24 | }): React.JSX.Element {
  25 |   const dragging = dragCursor ? '[.pane-slot.drag-src_&]:cursor-grabbing' : ''
  26 |   const padding = inset === 'default' ? 'pl-[var(--pane-head-leading-inset)]' : 'pl-[var(--space-2-5)]'
  27 |   return (
  28 |     <header
  29 |       {...props}
  30 |       onPointerDown={onPointerDown}
  31 |       className={`group pane-head touch-none select-none [&_input]:select-text flex items-center gap-2 pr-1 ${padding} h-[30px] min-h-[30px] border-b ${DIVIDER[divider]} flex-none cursor-grab active:cursor-grabbing ${dragging} ${TRANSITION[transition]} @container`}
  32 |     >
  33 |       {children}
  34 |     </header>
  35 |   )
  36 | }
  37 | 
```

### `ui/src/renderer/src/components/ui/paneFocus.css:1`

```tsx
   1 | /* Restates tailwind.css's layer order: this sheet can load first, and a layer is placed where it is first seen. */
   2 | @layer properties, theme, base, components, utilities;
   3 | 
   4 | /* Pane frame and header grounds by focus tier. Kept below `utilities` so a call site's
   5 |    utilities still win, as they did when these were classes: the narrow-container radius
   6 |    step on a pane root must override the default frame radius. */
   7 | @layer components {
   8 |   [data-pane-focus-border='none'] { border-color: var(--border); }
   9 |   [data-pane-focus-border='dim'] { border-color: var(--pane-focus-border-dim); }
  10 |   [data-pane-focus-border='full'] { border-color: var(--border-focus); }
  11 |   [data-pane-focus-head='none'] { background: var(--session-terminal-header-bg); }
  12 |   [data-pane-focus-head='dim'] { background: var(--pane-focus-head-dim); }
  13 |   [data-pane-focus-head='full'] { background: var(--raised); }
  14 |   [data-pane-focus-head] {
  15 |     font-size: var(--tr-text-small-size);
  16 |     font-weight: var(--tr-text-small-weight);
  17 |     letter-spacing: var(--tr-text-pane-header-tracking);
  18 |     color: var(--text-primary);
  19 |   }
  20 | 
  21 |   [data-pane-focus-border] {
  22 |     border-style: solid;
  23 |     border-width: var(--pane-frame-border-width);
  24 |     border-radius: var(--tr-radius-md);
  25 |   }
  26 | }
  27 | 
  28 | /* Unlayered on purpose: a title in an unfocused pane dims over its own tone utility. */
  29 | body:has(.pane.focus) .pane:not(.focus) .pane-title { color: var(--text-secondary); }
  30 | [data-grid-area='rail'] { grid-area: rail; }
```

### `ui/src/renderer/src/components/ui/WindowControl.tsx:1`

```tsx
   1 | import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
   2 | 
   3 | export function WindowControlButton({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
   4 |   return <button {...props} className={`btn flex items-center justify-center w-[calc(var(--w-window-control)/var(--shell-zoom,1))] h-[calc(var(--h-top)/var(--shell-zoom,1))] p-0 rounded-none border-none bg-transparent text-[var(--text-primary)] cursor-pointer [-webkit-app-region:no-drag] ${className}`}>{children}</button>
   5 | }
   6 | 
   7 | export function WindowControlDisc({ children, tone, className = '', ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; tone: 'close' | 'regular' }): React.JSX.Element {
   8 |   return <span {...props} className={`flex items-center justify-center w-[calc(var(--sz-window-control-disc)/var(--shell-zoom,1))] h-[calc(var(--sz-window-control-disc)/var(--shell-zoom,1))] rounded-[var(--tr-radius-sm)] bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] group-focus-visible/wc:outline-[var(--bw-window-control-focus)] group-focus-visible/wc:outline-[var(--focus-ring)] group-focus-visible/wc:outline-offset-1 motion-safe:transition-[background-color,color] motion-safe:duration-[var(--animate-t-fast)] ${tone === 'close' ? 'group-hover/wc:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] group-hover/wc:text-[var(--danger)] group-active/wc:bg-[color-mix(in_srgb,var(--danger)_30%,transparent)]' : 'group-hover/wc:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] group-hover/wc:text-[color-mix(in_srgb,var(--accent)_75%,var(--text-primary))] group-active/wc:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]'} ${className}`}>{children}</span>
   9 | }
  10 | 
  11 | export function WindowResizeGrip({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  12 |   return <div {...props} className={`fixed z-[var(--z-window)] [-webkit-app-region:no-drag] ${className}`} />
  13 | }
```

### `ui/src/renderer/src/components/ui/ToolbarActions.tsx:1`

```tsx
   1 | import type { ReactNode } from 'react'
   2 | 
   3 | /** The right-hand cluster of the top bar. */
   4 | export function ToolbarActions({ children }: { children: ReactNode }): React.JSX.Element {
   5 |   return <div className="ml-auto flex items-center gap-1 pr-1">{children}</div>
   6 | }
   7 | 
```

### `ui/src/renderer/src/components/ui/GridRailHoverCard.tsx:1`

```tsx
   1 | import { useRef } from 'react'
   2 | import { createPortal } from 'react-dom'
   3 | import { formatCheckout } from '../checkout/formatCheckout'
   4 | import type { SessionCheckout } from '../../houston/generated/SessionCheckout'
   5 | import type { RailCard, CheckoutIdentity } from '../rail/railCardModel'
   6 | import type { TagInfo } from '../../houston/generated/TagInfo'
   7 | import { Icon } from './Icon'
   8 | import { IconAgent, IconFolder, IconGitBranch, IconGitPullRequest, IconTag, IconTerminal, IconAlertTriangle } from '../icons'
   9 | import { PrLink } from './PrLink'
  10 | import './floatingSurface.css'
  11 | 
  12 | export const RAIL_HOVER_OPEN_DELAY_MS = 150
  13 | export const RAIL_HOVER_CLOSE_DELAY_MS = 0
  14 | export const RAIL_HOVER_WARM_WINDOW_MS = 400
  15 | 
  16 | export function useGridRailHoverWarmWindow(): { isWarm: () => boolean; markWarm: () => void } {
  17 |   const warmUntil = useRef(0)
  18 |   return {
  19 |     isWarm: () => Date.now() < warmUntil.current,
  20 |     markWarm: () => { warmUntil.current = Date.now() + RAIL_HOVER_WARM_WINDOW_MS }
  21 |   }
  22 | }
  23 | 
  24 | function checkoutFor(identity: CheckoutIdentity): { checkout: SessionCheckout | null; remoteHost?: string } {
  25 |   if (identity.kind === 'remote') return { checkout: null, remoteHost: identity.host }
  26 |   const kind = identity.kind === 'worktree'
  27 |     ? { worktree: { slug: identity.slug } }
  28 |     : identity.kind === 'primary' ? 'primary' : 'folder'
  29 |   return {
  30 |     checkout: { root: identity.root, kind, branch: 'branch' in identity ? identity.branch : null, head: null }
  31 |   }
  32 | }
  33 | 
  34 | export function GridRailHoverCard({
  35 |   card,
  36 |   tags = [],
  37 |   position,
  38 |   visible = true,
  39 |   onOpenInspector
  40 | }: {
  41 |   card: RailCard
  42 |   tags?: readonly TagInfo[]
  43 |   position: { left: number; top: number }
  44 |   visible?: boolean
  45 |   closeTimer: React.MutableRefObject<ReturnType<typeof window.setTimeout> | null>
  46 |   scheduleClose: () => void
  47 |   onOpenInspector?: (paneId: number, tab: 'changes' | 'pull-request') => void
  48 | }): React.JSX.Element {
  49 |   const pr = card.pr?.pr
  50 |   const firstPane = card.agents[0]?.session.id
  51 |   return createPortal(
  52 |     <div
  53 |       className={`grid-hover-card floating-glass ${visible ? 'floating-pop-in' : ''} fixed z-[var(--z-tooltip)] grid w-[300px] gap-[var(--space-2)]
  54 |         p-[var(--space-3)] text-[length:var(--tr-text-small-size)]
  55 |         transition-[opacity,transform,top] duration-150 ease-out`}
  56 |       style={{ ...position, transformOrigin: 'left top' }}
  57 |       role="tooltip"
  58 |       data-testid="grid-hover-card"
  59 |       data-visible={visible}
  60 |     >
  61 |       <strong className="min-w-0 truncate font-medium leading-[15px] text-[var(--text-primary)]">{card.title}</strong>
  62 |       <div className="grid gap-[var(--space-1-5)] pl-[var(--space-0-5)] text-[var(--text-secondary)]">
  63 |         <div className="flex items-center gap-2"><Icon glyph={IconFolder} role="small" className="text-[var(--text-muted)]" />{card.workspace.split('/').filter(Boolean).at(-1) ?? card.workspace}</div>
  64 |         <div className="flex items-center gap-2"><Icon glyph={IconTerminal} role="small" className="text-[var(--text-muted)]" />{card.checkouts[0]?.kind === 'remote' ? card.checkouts[0].host : 'Local'}</div>
  65 |         {card.checkouts.length > 0 && <div className="grid gap-[var(--space-1-5)]" data-testid="grid-hover-checkouts">
  66 |         {card.checkouts.slice(0, 1).map((identity) => {
  67 |           const formatted = checkoutFor(identity)
  68 |           const label = formatCheckout(formatted.checkout, { remoteHost: formatted.remoteHost })
  69 |           return <div
  70 |             key={`${identity.kind}:${'root' in identity ? identity.root : identity.host}`}
  71 |             className="flex min-w-0 items-center gap-[var(--space-2)]"
  72 |           >
  73 |             <Icon glyph={IconGitBranch} role="small" className="flex-none text-[var(--text-muted)]" />
  74 |             <span className="truncate font-mono [font-size:var(--tr-text-label-size)]">{card.agents.length && 'branch' in identity ? identity.branch ?? label.text : label.text}</span>
  75 |           </div>
  76 |         })}
  77 |         </div>}
  78 |         {card.agents[0] && <div className="flex items-center gap-2">
  79 |           <IconAgent agent={card.agents[0].agent} role="small" brand />
  80 |           <span>{card.agents[0].model ?? card.agents[0].agent}</span>
  81 |           {card.agents.length > 1 && <span className="text-[var(--text-muted)]">+{card.agents.length - 1} {card.agents.length === 2 ? 'agent' : 'agents'}</span>}
  82 |         </div>}
  83 |         {tags.length > 0 && <div className="flex flex-wrap items-center gap-2"><Icon glyph={IconTag} role="small" className="text-[var(--text-muted)]" />{tags.map((tag) => <span key={tag.id} className="inline-flex items-center gap-1"><i className="size-1.5 rounded-full" style={{ background: tag.color }} />{tag.name}</span>)}</div>}
  84 |         {card.status.kind === 'needs-input' && <div className="flex items-center gap-2 text-[var(--warn)]"><Icon glyph={IconAlertTriangle} role="small" />Waiting for your answer</div>}
  85 |       </div>
  86 |       {pr && (
  87 |         <PrLink
  88 |           href={pr.url}
  89 |           onClick={() => {
  90 |             if (firstPane != null) onOpenInspector?.(firstPane, 'pull-request')
  91 |           }}
  92 |           className="w-full min-w-0 justify-start gap-[var(--space-1-5)] border-t border-[var(--divider)]
  93 |             pt-[var(--space-2)] text-left text-[length:var(--tr-text-label-size)]"
  94 |           aria-label={`Open pull request ${pr.number}`}
  95 |         >
  96 |         <span className="inline-flex items-center gap-[var(--space-1)] font-mono text-[var(--text-muted)]">
  97 |           <Icon glyph={IconGitPullRequest} role="small" />#{pr.number}
  98 |         </span>
  99 |         <span className="min-w-0 truncate text-[var(--text-primary)]">{pr.title}</span>
 100 |         {card.agents.length === 0 && <><span className="flex-none text-[var(--text-muted)]">{pr.checks}</span><span className="flex-none font-mono text-[var(--ok)]">+{pr.additions}</span><span className="flex-none font-mono text-[var(--stop)]">−{pr.deletions}</span></>}
 101 |         </PrLink>
 102 |       )}
 103 |       {card.agents.length === 0 && <div className="text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]">
 104 |         0 panes
 105 |       </div>}
 106 |     </div>,
 107 |     document.body
 108 |   )
 109 | }
 110 | 
```

### `ui/src/renderer/src/components/Shell/Shell.tsx:20`

```tsx
  20 |   return (
  21 |     <Viewport
  22 |       className="relative grid overflow-hidden"
  23 |       style={{
  24 |         ['--w-rail' as string]: railCollapsed ? '0px' : `${railWidth}px`,
  25 |         gridTemplateColumns: 'var(--w-rail) minmax(0, 1fr)',
  26 |         gridTemplateRows: 'var(--h-top) 1fr',
  27 |         gridTemplateAreas: '"rail topbar" "rail grid"'
  28 |       } as CSSProperties}
  29 |     >
  30 |       <BackdropMount
  31 |         theme={chromeTheme}
  32 |         {...(onBackgroundUnavailable ? { onUnavailable: onBackgroundUnavailable } : {})}
  33 |       />
  34 |       {children}
  35 |     </Viewport>
  36 |   )
  37 | }
```

### `ui/src/renderer/src/components/LayoutView.tsx:185`

```tsx
 185 | 
 186 | const SPLITTER_KEY_STEP = 0.04
 187 | 
 188 | const GUTTER = 'var(--pane-gutter)'
 189 | const HALF_GUTTER = 'calc(var(--pane-gutter) / 2)'
 190 | const EDGE_EPS = 0.01
 191 | function gutterInsets(rect: { x: number; y: number; w: number; h: number }): {
 192 |   left: string
 193 |   top: string
 194 |   right: string
 195 |   bottom: string
 196 | } {
 197 |   const atLeft = rect.x <= EDGE_EPS
 198 |   const atTop = rect.y <= EDGE_EPS
 199 |   const atRight = rect.x + rect.w >= 100 - EDGE_EPS
 200 |   const atBottom = rect.y + rect.h >= 100 - EDGE_EPS
 201 |   return {
 202 |     left: atLeft ? GUTTER : HALF_GUTTER,
 203 |     top: atTop ? GUTTER : HALF_GUTTER,
 204 |     right: atRight ? GUTTER : HALF_GUTTER,
 205 |     bottom: atBottom ? GUTTER : HALF_GUTTER
 206 |   }
 207 | }
 208 | 
 209 | function paneSlotGeometry(rect: { x: number; y: number; w: number; h: number }): {
 210 |   left: string
 211 |   top: string
 212 |   width: string
 213 |   height: string
 214 | } {
 215 |   const gutter = gutterInsets(rect)
 216 |   return {
 217 |     left: `calc(${rect.x}% + ${gutter.left})`,
 218 |     top: `calc(${rect.y}% + ${gutter.top})`,
 219 |     width: `calc(${rect.w}% - ${gutter.left} - ${gutter.right})`,
 220 |     height: `calc(${rect.h}% - ${gutter.top} - ${gutter.bottom})`
 221 |   }
 222 | }
 223 | 
```

### `ui/src/renderer/src/components/Sidebar.tsx:209`

```tsx
 209 | function RailTreeContent({ groupBy, virtualItems, compact, dragging, renderWorkspaceContent }: {
 210 |   groupBy: RailPrefs['groupBy'];
 211 |   virtualItems: RailVirtualItem[];
 212 |   compact: boolean;
 213 |   dragging: boolean;
 214 |   renderWorkspaceContent: () => React.ReactNode;
 215 | }): React.JSX.Element {
 216 |   void groupBy;
 217 |   void renderWorkspaceContent;
 218 |   return <RailVirtualList items={virtualItems} compact={compact} dragging={dragging} />;
 219 | }
 220 | 
 221 | function WorkspaceRailGroupRow({
 222 |   workspace,
 223 |   count,
 224 |   hasGrids,
 225 |   index,
 226 |   color,
 227 |   collapsed,
 228 |   selected,
 229 |   pinned,
 230 |   dragging,
 231 |   dragged,
 232 |   renaming,
 233 |   dragActiveRef,
 234 |   startWsDrag,
 235 |   onSelect,
 236 |   onToggle,
 237 |   onOpenMenu,
 238 |   onNewSession,
 239 |   onRenameSubmit,
 240 |   onRenameCancel,
 241 | }: {
 242 |   workspace: Workspace;
 243 |   count: number;
 244 |   hasGrids: boolean;
 245 |   index: number;
 246 |   color: string;
 247 |   collapsed: boolean;
 248 |   selected: boolean;
 249 |   pinned: boolean;
 250 |   dragging: boolean;
 251 |   dragged: boolean;
 252 |   renaming: boolean;
 253 |   dragActiveRef: React.RefObject<boolean>;
 254 |   startWsDrag: (event: React.PointerEvent, path: string) => void;
 255 |   onSelect: (path: string) => void;
 256 |   onToggle: (path: string) => void;
 257 |   onOpenMenu: (event: React.MouseEvent, workspace: Workspace, color: string) => void;
 258 |   onNewSession?: (path: string) => void;
 259 |   onRenameSubmit: (path: string, name: string) => void;
 260 |   onRenameCancel: () => void;
 261 | }): React.JSX.Element {
 262 |   if (renaming) {
 263 |     return <WorkspaceRenameField w={workspace} i={index} color={color} onRenameSubmit={onRenameSubmit} onRenameCancel={onRenameCancel} />;
 264 |   }
 265 |   return (
 266 |     <Tooltip label={workspace.path}>
 267 |       <RailWorkspaceGroupRow
 268 |         kind="tree"
 269 |         selected={selected}
 270 |         dragging={dragging}
 271 |         dragged={dragged}
 272 |         role="button"
 273 |         tabIndex={0}
 274 |         aria-label={workspace.path}
 275 |         aria-current={selected ? 'true' : undefined}
 276 |         aria-expanded={hasGrids ? !collapsed : undefined}
 277 |         data-testid={hasGrids ? 'ws-disclosure' : undefined}
 278 |         data-ws-idx={index}
 279 |         data-dragging={dragged || undefined}
 280 |         onPointerDown={(event) => {
 281 |           dragActiveRef.current = false;
 282 |           if (event.button === 0) startWsDrag(event, workspace.path);
 283 |         }}
 284 |         onClick={() => {
 285 |           if (dragActiveRef.current) {
 286 |             dragActiveRef.current = false;
 287 |             return;
 288 |           }
 289 |           if (selected) onToggle(workspace.path);
 290 |           else onSelect(workspace.path);
 291 |         }}
 292 |         onKeyDown={(event) => {
 293 |           if (event.key !== 'Enter' && event.key !== ' ') return;
 294 |           event.preventDefault();
 295 |           if (selected) onToggle(workspace.path);
 296 |           else onSelect(workspace.path);
 297 |         }}
 298 |         onContextMenu={(event) => onOpenMenu(event, workspace, color)}
 299 |       >
 300 |         {hasGrids && (
 301 |           <Button
 302 |             type="button"
 303 |             variant="disclosure-icon"
 304 |             aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${workspace.name}`}
 305 |             data-testid="ws-chevron"
 306 |             className="flex-none"
 307 |             onPointerDown={(event) => event.stopPropagation()}
 308 |             onClick={(event) => {
 309 |               event.stopPropagation();
 310 |               onToggle(workspace.path);
 311 |             }}
 312 |           >
 313 |             <RailChevron collapsed={collapsed} />
 314 |           </Button>
 315 |         )}
 316 |         {!hasGrids && <span aria-hidden="true" className="flex-none"><RailChevron collapsed /></span>}
 317 |         <Icon glyph={IconFolder} role="ui" opacity="muted" />
 318 |         <WorkspaceTreeLabel heading>{workspace.name}</WorkspaceTreeLabel>
 319 |         {count > 0 && <RailRowCount count={count} />}
 320 |         {pinned && <PinIndicator />}
 321 |         <WorkspaceTreeActions>
 322 |           {onNewSession && (
 323 |             <Tooltip label="New session">
 324 |               <WorkspaceTreeAuxButton
 325 |                 aria-label={`New session in ${workspace.name}`}
 326 |                 data-testid="ws-new-session"
 327 |                 onPointerDown={(event) => event.stopPropagation()}
 328 |                 onClick={(event) => { event.stopPropagation(); onNewSession(workspace.path); }}
 329 |               >
 330 |                 <Icon glyph={IconPlus} role="small" />
 331 |               </WorkspaceTreeAuxButton>
 332 |             </Tooltip>
 333 |           )}
 334 |         </WorkspaceTreeActions>
 335 |       </RailWorkspaceGroupRow>
 336 |     </Tooltip>
```

### `ui/src/renderer/src/components/Sidebar.tsx:399`

```tsx
 399 | export const WS_COLORS = [
 400 |   "#94a3b8",
 401 |   "#ef4444",
 402 |   "#f97316",
 403 |   "#f59e0b",
 404 |   "#eab308",
 405 |   "#84cc16",
 406 |   "#22c55e",
 407 |   "#10b981",
 408 |   "#14b8a6",
 409 |   "#06b6d4",
 410 |   "#0ea5e9",
 411 |   "#3b82f6",
 412 |   "#8b5cf6",
 413 |   "#ec4899",
 414 |   "#f43f5e",
 415 | ];
```

### `ui/src/renderer/src/components/Sidebar.tsx:908`

```tsx
 908 |   return (
 909 |     <Fragment>
 910 |       {dropBefore}
 911 |       <Tooltip label={w.path}>
 912 |         <WorkspaceTreeRow
 913 |           kind="tree"
 914 |           dragging={dragPath !== null}
 915 |           dragged={dragPath === w.path}
 916 |           role="button"
 917 |           tabIndex={0}
 918 |           aria-label={w.path}
 919 |           data-ws-idx={i}
 920 |           data-testid="ws-disclosure"
 921 |           aria-current={on ? "true" : undefined}
 922 |           aria-expanded={false}
 923 |           data-dragging={dragPath === w.path || undefined}
 924 |           onPointerDown={(e) => {
 925 |             dragActiveRef.current = false;
 926 |             if (e.button !== 0) return;
 927 |             startWsDrag(e, w.path);
 928 |           }}
 929 |           onClick={() => {
 930 |             if (dragActiveRef.current) {
 931 |               dragActiveRef.current = false;
 932 |               return;
 933 |             }
 934 |             if (selected !== w.path) onSelect(w.path);
 935 |             toggleWsOpen(w.path);
 936 |           }}
 937 |           onKeyDown={(e) => {
 938 |             if (e.key !== "Enter" && e.key !== " ") return;
 939 |             e.preventDefault();
 940 |             if (selected !== w.path) onSelect(w.path);
 941 |             toggleWsOpen(w.path);
 942 |           }}
 943 |           onContextMenu={(e) => openMenu(e, w, color)}
 944 |         >
 945 |           <Button
 946 |             type="button"
 947 |             variant="disclosure-icon"
 948 |             aria-label={`Expand ${w.name}`}
 949 |             data-testid="ws-chevron"
 950 |             className="flex-none"
 951 |             onPointerDown={(e) => e.stopPropagation()}
 952 |             onClick={(e) => {
 953 |               e.stopPropagation();
 954 |               toggleWsOpen(w.path);
 955 |             }}
 956 |           >
 957 |             <Icon glyph={IconChevronRight} role="small" opacity="subtle" />
 958 |           </Button>
 959 |           <Icon glyph={IconFolder} role="ui" opacity="muted" />
 960 |           <WorkspaceTreeLabel>
 961 |             {w.name}
 962 |           </WorkspaceTreeLabel>
 963 |           <WorkspaceTreeActions>
 964 |             {pinned && <PinIndicator />}
 965 |           </WorkspaceTreeActions>
 966 |         </WorkspaceTreeRow>
 967 |       </Tooltip>
 968 |     </Fragment>
 969 |   );
 970 | }
 971 | 
 972 | type GridLifecycle =
 973 |   | "starting"
 974 |   | "working"
```

### `ui/src/renderer/src/components/Sidebar.tsx:1139`

```tsx
1139 |   return (
1140 |     <Fragment>
1141 |       {dropBefore}
1142 |       {renamingThis ? (
1143 |         <WorkspaceRenameField
1144 |           w={w}
1145 |           i={i}
1146 |           color={color}
1147 |           onRenameSubmit={onRenameSubmit}
1148 |           onRenameCancel={onRenameCancel}
1149 |         />
1150 |       ) : (
1151 |       <Tooltip label={w.path}>
1152 |         <WorkspaceTreeRow
1153 |           kind="tree"
1154 |           selected={on}
1155 |           dragging={dragPath !== null}
1156 |           dragged={dragPath === w.path}
1157 |           role="button"
1158 |           tabIndex={0}
1159 |           aria-label={w.path}
1160 |           data-ws-idx={i}
1161 |           data-testid="ws-disclosure"
1162 |           aria-current={on ? "true" : undefined}
1163 |           aria-expanded={true}
1164 |           data-dragging={dragPath === w.path || undefined}
1165 |           onPointerDown={(e) => {
1166 |             dragActiveRef.current = false;
1167 |             if (e.button !== 0) return;
1168 |             startWsDrag(e, w.path);
1169 |           }}
1170 |           onClick={() => {
1171 |             if (dragActiveRef.current) {
1172 |               dragActiveRef.current = false;
1173 |               return;
1174 |             }
1175 |             if (selected === w.path) toggleWsOpen(w.path);
1176 |             else onSelect(w.path);
1177 |           }}
1178 |           onKeyDown={(e) => {
1179 |             if (e.key !== "Enter" && e.key !== " ") return;
1180 |             e.preventDefault();
1181 |             if (selected === w.path) toggleWsOpen(w.path);
1182 |             else onSelect(w.path);
1183 |           }}
1184 |           onContextMenu={(e) => openMenu(e, w, color)}
1185 |         >
1186 |           <Button
1187 |             type="button"
1188 |             variant="disclosure-icon"
1189 |             aria-label={`Collapse ${w.name}`}
1190 |             data-testid="ws-chevron"
1191 |             className="flex-none"
1192 |             onPointerDown={(e) => e.stopPropagation()}
1193 |             onClick={(e) => {
1194 |               e.stopPropagation();
1195 |               toggleWsOpen(w.path);
1196 |             }}
1197 |           >
1198 |             <Icon glyph={IconChevronRight} role="small" rotated />
1199 |           </Button>
1200 |           <Icon glyph={IconFolder} role="ui" opacity="muted" />
1201 |           <WorkspaceTreeLabel>
1202 |             {w.name}
1203 |           </WorkspaceTreeLabel>
1204 |           <WorkspaceTreeActions>
1205 |             {pinned && <PinIndicator />}
1206 |           </WorkspaceTreeActions>
1207 |           {onNewWorkspaceSession && (
1208 |             <Tooltip label="New session">
1209 |               <WorkspaceTreeAuxButton
1210 |                 type="button"
1211 |                 aria-label={`New session in ${w.name}`}
1212 |                 data-testid="ws-new-session"
1213 |                 onPointerDown={(e) => e.stopPropagation()}
1214 |                 onClick={(e) => {
1215 |                   e.stopPropagation();
1216 |                   onNewWorkspaceSession(w.path);
1217 |                 }}
1218 |               >
1219 |                 <Icon glyph={IconPlus} role="small" />
1220 |               </WorkspaceTreeAuxButton>
1221 |             </Tooltip>
1222 |           )}
1223 |         </WorkspaceTreeRow>
1224 |       </Tooltip>
1225 |       )}
1226 |       {[...grids]
1227 |         .sort((left, right) => Number(pinnedGridIds.has(gridStorageKey(w.path, right.id))) - Number(pinnedGridIds.has(gridStorageKey(w.path, left.id))))
1228 |         .map((g, gridIndex, orderedGrids) => {
1229 |         if (hiddenByTagFilter(g, activeTagIds)) return null;
1230 |         const gridOn =
1231 |           selected === w.path && selectedGridId === g.id;
1232 |         const stateDot = (
1233 |           <GridStateDot
1234 |             sessionIds={g.sessionIds}
1235 |             state={g.state ?? undefined}
1236 |             label={g.statusLabel ?? undefined}
1237 |           />
1238 |         );
1239 |         if (
1240 |           gridRenaming?.path === w.path &&
1241 |           gridRenaming.gridId === g.id &&
1242 |           onRenameGrid
1243 |         ) {
1244 |           return (
1245 |             <WorkspaceTreeRow
1246 |               key={g.id}
1247 |               kind="child"
1248 |               data-testid="grid-row-renaming"
1249 |             >
1250 |               {stateDot}
1251 |               <Icon glyph={IconGrid} role="ui" opacity="muted" />
1252 |               <RenameInput
1253 |                 initial={g.name}
1254 |                 onSubmit={(name) => {
1255 |                   setGridRenaming(null);
1256 |                   const next = name.trim();
1257 |                   if (next && next !== g.name) onRenameGrid(w.path, g.id, next);
1258 |                 }}
1259 |                 onCancel={() => setGridRenaming(null)}
1260 |               />
1261 |             </WorkspaceTreeRow>
1262 |           );
1263 |         }
1264 |         const onRemove = onRemoveGrid ? () => onRemoveGrid(w.path, g.id) : undefined;
1265 |         return (
1266 |           <Fragment key={g.id}>
1267 |             {gridIndex === 0 && pinnedGridIds.has(gridStorageKey(w.path, g.id)) && <WorkspaceGroupLabel>Pinned</WorkspaceGroupLabel>}
1268 |             {gridIndex > 0 && !pinnedGridIds.has(gridStorageKey(w.path, g.id)) && pinnedGridIds.has(gridStorageKey(w.path, orderedGrids[gridIndex - 1]?.id ?? '')) && (
1269 |               <WorkspaceGroupDivider><HorizontalRule /></WorkspaceGroupDivider>
1270 |             )}
1271 |             <Suspense
1272 |               fallback={
1273 |                 <GridRailRowFallback
1274 |                   name={g.name}
1275 |                   selected={gridOn}
1276 |                   jumpNumber={grids.indexOf(g) + 1}
1277 |                   onSelect={() => onSelectGrid?.(w.path, g.id)}
1278 |                   onContextMenu={(event) => openGridMenu(event, w.path, g, Boolean(onRemoveGrid))}
1279 |                   onRemove={onRemove}
1280 |                 />
1281 |               }
1282 |             >
1283 |               <LazyGridRailRow
1284 |           key={g.id}
1285 |           name={g.name}
```

### `ui/src/renderer/src/components/Sidebar.tsx:1461`

```tsx
1461 | function RailHead({
1462 |   onHeadMouseDown,
1463 |   onHeadDoubleClick,
1464 |   onHideRail,
1465 | }: {
1466 |   onHeadMouseDown?: (e: React.MouseEvent) => void;
1467 |   onHeadDoubleClick?: (e: React.MouseEvent) => void;
1468 |   onHideRail?: () => void;
1469 | }): React.JSX.Element {
1470 |   return (
1471 |     <NavigationRailHeader
1472 |       logo={logoUrl}
1473 |       onMouseDown={onHeadMouseDown}
1474 |       onDoubleClick={onHeadDoubleClick}
1475 |       action={onHideRail && (
1476 |         <Tooltip label="Hide sidebar (Ctrl+B)">
1477 |           <Button
1478 |             variant="subtle-icon"
1479 |             aria-label="Hide sidebar"
1480 |             noDrag
1481 |             onClick={onHideRail}
1482 |           >
1483 |             <Icon glyph={IconPanelLeft} role="ui" />
1484 |           </Button>
1485 |         </Tooltip>
1486 |       )}
1487 |     >
1488 |       Houston
1489 |     </NavigationRailHeader>
1490 |   );
1491 | }
1492 | 
1493 | const RAIL_VIEW_ICON: Readonly<Record<RailView, (p: IconProps) => React.JSX.Element>> =
1494 |   Object.freeze({
1495 |     tasks: IconTasks,
1496 |     skills: IconZap,
1497 |     routines: IconClock,
1498 |     harness: IconTarget,
1499 |     mcp: IconGlobe,
1500 |     prs: IconGitPullRequest,
1501 |     usage: IconChartArea,
1502 |   });
1503 | 
1504 | function RailNav({
1505 |   view,
1506 |   hidden,
1507 |   paletteChord,
1508 |   taskTurnCount,
1509 |   onOpenPalette,
1510 |   onSelect,
1511 |   onRowMenu,
1512 |   harnessAttention,
1513 | }: {
1514 |   view: RailView | null;
1515 |   hidden: ReadonlySet<RailView>;
1516 |   paletteChord: string | null | undefined;
1517 |   taskTurnCount: number;
1518 |   onOpenPalette: (() => void) | undefined;
1519 |   onSelect: (v: RailView) => void;
1520 |   onRowMenu: (e: React.MouseEvent, v: RailView) => void;
1521 |   harnessAttention?: number;
1522 | }): React.JSX.Element {
1523 |   const shown = RAIL_VIEWS.filter((v) => v !== "prs" && v !== "usage" && !hidden.has(v));
1524 |   return (
1525 |     <NavigationRail>
1526 |       <Tooltip label={paletteChord ? `Search (${paletteChord})` : "Search"}>
1527 |         <NavigationRailSearch paletteChord={paletteChord} onClick={onOpenPalette} />
1528 |       </Tooltip>
1529 |       {shown.map((v) => {
1530 |         const on = view === v;
1531 |         return (
1532 |           <NavigationRailItem
1533 |             key={v}
1534 |             data-testid="rail-nav-row"
1535 |             data-view={v}
1536 |             icon={RAIL_VIEW_ICON[v]}
1537 |             label={RAIL_VIEW_LABEL[v]}
1538 |             selected={on}
1539 |             onClick={() => onSelect(v)}
1540 |             onContextMenu={(e) => onRowMenu(e, v)}
1541 |             trailing={
1542 |               v === "harness" ? <Count value={harnessAttention ?? 0} from="accent" /> :
1543 |                 v === "tasks" && taskTurnCount > 0 ? <Count value={taskTurnCount} from="accent" /> : null
1544 |             }
1545 |           />
1546 |         );
1547 |       })}
1548 |     </NavigationRail>
1549 |   );
1550 | }
1551 | 
1552 | function NavViewMenu({
1553 |   navMenu,
1554 |   onClose,
1555 |   onHide,
1556 | }: {
```

### `ui/src/renderer/src/components/Sidebar.tsx:2063`

```tsx
2063 |   })
2064 |   const groupHeader = (label: string, count: number, workspace?: Workspace, index = 0): React.JSX.Element => {
2065 |     if (workspace) {
2066 |       const collapsed = !isWsOpen(workspace.path);
2067 |       return (
2068 |         <WorkspaceRailGroupRow
2069 |           workspace={workspace}
2070 |           index={index}
2071 |           color={colorOf(workspace.path)}
2072 |           count={count}
2073 |           hasGrids={(gridsByWorkspace[workspace.path] ?? []).some((grid) => !isPlaceholderGrid(workspace.path, grid))}
2074 |           collapsed={collapsed}
2075 |           selected={selected === workspace.path}
2076 |           pinned={pinnedWorkspaces.has(workspace.path)}
2077 |           dragging={dragPath !== null}
2078 |           dragged={dragPath === workspace.path}
2079 |           renaming={renaming === workspace.path}
2080 |           dragActiveRef={dragActiveRef}
2081 |           startWsDrag={startWsDrag}
2082 |           onSelect={onSelect}
2083 |           onToggle={toggleWsOpen}
2084 |           onOpenMenu={openMenu}
2085 |           onNewSession={onNewWorkspaceSession}
2086 |           onRenameSubmit={onRenameSubmit}
2087 |           onRenameCancel={onRenameCancel}
2088 |         />
2089 |       );
2090 |     }
2091 |     return (
2092 |       <RailGroupHeader>
2093 |         <RailGroupToggle
2094 |           aria-expanded={!railPrefs.collapsedGroups.includes(label)}
2095 |           onClick={() => toggleGroup(label)}
2096 |         >
2097 |           {label === 'Pinned' ? <Icon glyph={IconPin} role="small" tone="faint" className="flex-none" />
2098 |             : railPrefs.groupBy === 'status' ? <RailGroupStatusDot label={label} />
2099 |               : <Icon glyph={IconGitPullRequest} role="small" tone="faint" className="flex-none" />}
2100 |           <span className="truncate">{label}</span>
2101 |           {count > 0 && <RailGroupCount>{count}</RailGroupCount>}
2102 |         </RailGroupToggle>
2103 |       </RailGroupHeader>
2104 |     );
2105 |   };
2106 |   if (pinnedCards.length > 0) {
2107 |     virtualItems.push({
2108 |       key: 'group:pinned',
2109 |       kind: 'group',
2110 |       content: groupHeader('Pinned', pinnedCards.length),
2111 |     })
2112 |     if (!railPrefs.collapsedGroups.includes('Pinned')) {
2113 |       pinnedCards.forEach((entry) => virtualItems.push({
2114 |         key: `card:${cardKey(entry)}`,
2115 |         kind: 'card',
2116 |         content: renderFlatCard(entry),
2117 |       }))
2118 |     }
2119 |   }
2120 |   const workspaceGroups = railPrefs.groupBy === 'workspace'
2121 |     ? filteredWorkspaces
2122 |       // A workspace whose grids are all pinned is represented by the Pinned group alone.
2123 |       .filter((workspace) => !(gridsByWorkspace[workspace.path] ?? []).length || (gridsByWorkspace[workspace.path] ?? []).some((grid) => !pinnedGridIds.has(gridStorageKey(workspace.path, grid.id))))
2124 |       .map((workspace) => [workspace.name, unpinnedCards.filter((entry) => entry.workspace.path === workspace.path), workspace] as const)
2125 |     : groupEntries.map(([label, cards]) => [label, cards, undefined] as const)
2126 |   for (const [label, cards, workspace] of workspaceGroups) {
2127 |     if (label) virtualItems.push({
2128 |       key: `group:${workspace?.path ?? label}`,
2129 |       kind: 'group',
2130 |       content: groupHeader(label, cards.length, workspace, workspace ? filteredWorkspaces.findIndex((entry) => entry.path === workspace.path) : 0),
2131 |     })
2132 |     if (workspace ? isWsOpen(workspace.path) : !railPrefs.collapsedGroups.includes(label)) {
2133 |       cards.forEach((entry) => virtualItems.push({
2134 |         key: `card:${cardKey(entry)}`,
2135 |         kind: 'card',
2136 |         content: renderFlatCard(entry),
2137 |       }))
2138 |     }
2139 |   }
2140 |   if (virtualItems.length === 0) {
```

### `ui/src/renderer/src/components/Sidebar.tsx:2153`

```tsx
2153 |   return (
2154 |     <NavigationRailSection data-testid="rail-tree">
2155 |       <RailTreeGroupHeader>
2156 |         <RailTreeTitle>{treeLabel}</RailTreeTitle>
2157 |         <Tooltip label="Sidebar options">
2158 |           <Button
2159 |             type="button"
2160 |             variant="compact-icon"
2161 |             aria-label="Sidebar options"
2162 |             aria-expanded={railOptionsAnchor !== null}
2163 |             data-testid="tree-filter-toggle"
2164 |             data-options-testid="rail-options-trigger"
2165 |             ref={optionsTriggerRef}
2166 |             onClick={(event) => setRailOptionsAnchor(railOptionsAnchor ? null : event.currentTarget)}
2167 |             className="relative"
2168 |           >
2169 |             <Icon glyph={IconSliders} role="ui" />
2170 |             {activeFilterCount > 0 && (
2171 |               <RailFilterCountBadge>
2172 |                 {activeFilterCount > 9 ? '9+' : activeFilterCount}
2173 |               </RailFilterCountBadge>
2174 |             )}
2175 |           </Button>
2176 |         </Tooltip>
2177 |         <Tooltip label="Add workspace">
2178 |           <span><AddWorkspaceMenu onAddWorkspace={onAddWorkspace} onSshConnect={onSshConnect} /></span>
2179 |         </Tooltip>
2180 |         <Tooltip label="New grid">
2181 |           <Button
2182 |             type="button"
2183 |             variant="compact-icon"
2184 |             aria-label="New grid"
2185 |             disabled={!onAddGrid}
2186 |             onClick={() => onAddGrid?.(selected)}
2187 |           >
2188 |             <Icon glyph={IconPlus} role="ui" />
2189 |           </Button>
2190 |         </Tooltip>
2191 |         <RailOptionsMenuHost
2192 |           anchor={railOptionsAnchor}
2193 |           prefs={railPrefs}
2194 |           onChange={onRailPrefsChange}
2195 |           onClose={() => setRailOptionsAnchor(null)}
2196 |           selectedTagIds={activeTagIds}
2197 |           selectedTagColors={activeTagIds.flatMap((id) => tagById.get(id)?.color ?? [])}
2198 |           onClearTagFilter={onClearTagFilter}
2199 |         />
2200 |       </RailTreeGroupHeader>
2201 | 
2202 |       <RailTreeContent groupBy={railPrefs.groupBy} virtualItems={virtualItems} compact={railPrefs.cardMode === 'compact'} dragging={dragPath !== null} renderWorkspaceContent={() => (
2203 |         <WorkspaceList dragging={dragPath !== null}>
2204 |           {filteredWorkspaces.map((w, i) => {
2205 |             const color = colorOf(w.path);
2206 |             const on = selected === w.path;
```

### `ui/src/renderer/src/components/Sidebar.tsx:2983`

```tsx
2983 |       <NavigationRailFooter>
2984 |         {}
2985 |         <Tooltip label="Settings">
2986 |           <Button
2987 |             variant="subtle-icon"
2988 |             aria-label="Settings"
2989 |             aria-pressed={settingsOpen}
2990 |             selected={settingsOpen}
2991 |             onClick={onOpenSettings}
2992 |           >
2993 |             <Icon glyph={IconGear} role="ui" />
2994 |           </Button>
2995 |         </Tooltip>
2996 |         <Tooltip label="Pull requests">
2997 |           <Button
2998 |             variant="subtle-icon"
2999 |             aria-label="Pull requests"
3000 |             aria-current={activeRailView === "prs" ? "page" : undefined}
3001 |             selected={activeRailView === "prs"}
3002 |             data-testid="rail-footer-pull-requests"
3003 |             onClick={onOpenPullRequests}
3004 |           >
3005 |             <Icon glyph={IconGitPullRequest} role="ui" />
3006 |           </Button>
3007 |         </Tooltip>
3008 |         <Tooltip label="Usage">
3009 |           <Button
3010 |             variant="subtle-icon"
3011 |             aria-label="Usage"
3012 |             aria-current={activeRailView === "usage" ? "page" : undefined}
3013 |             onClick={() => selectRailView("usage")}
3014 |           >
3015 |             <Icon glyph={IconChartArea} role="ui" />
3016 |           </Button>
3017 |         </Tooltip>
3018 |         <Tooltip label={chromeTheme === "paper" ? "Switch to dark theme" : "Switch to light theme"}>
3019 |           <Button
3020 |             variant="subtle-icon"
3021 |             aria-label={chromeTheme === "paper" ? "Switch to dark theme" : "Switch to light theme"}
3022 |             onClick={(event) => onToggleChromeTheme(event.currentTarget)}
3023 |           >
3024 |             <Icon glyph={chromeTheme === "paper" ? IconSun : IconMoon} role="ui" />
3025 |           </Button>
3026 |         </Tooltip>
3027 |         <RailUpdateButton version={updateVersion} />
3028 |       </NavigationRailFooter>
```

### `ui/src/renderer/src/components/SessionPane.tsx:550`

```tsx
 550 |       onPointerDownCapture={() => onActivate(info.id)}
 551 |       onContextMenu={(e) => {
 552 |         if ((e.target as HTMLElement).closest('.pane-head')) return
 553 |         e.preventDefault()
 554 |         openMenuAt(e.clientX, e.clientY)
 555 |       }}
 556 |     >
 557 |       <PaneHeader
 558 |         data-pane-focus-head={focusTier}
 559 |         divider="solid"
 560 |         transition="background"
 561 |         dragCursor
 562 |         onPointerDown={(e) => {
 563 |           if ((e.target as HTMLElement).closest('button, input, [data-pane-head-control]')) return
 564 |           onHeaderPointerDown(info.id, e)
 565 |         }}
 566 |       >
 567 |         <PaneHeadIdentity>
 568 |           <SessionHeaderStatusDot info={info} live={live} />
 569 |           <Tooltip label={`${glyphAgent} session`}>
 570 |             <PaneEngineGlyph
 571 |               data-testid="engine-glyph"
 572 |               aria-label={`${glyphAgent} session`}
 573 |               className="[@container_(max-width:360px)]:hidden"
 574 |               style={{ color: engineGlyphColor(glyphAgent) }}
 575 |             >
 576 |               <IconAgent agent={glyphAgent} className={ICON_ROLE_CLS.ui} />
 577 |             </PaneEngineGlyph>
 578 |           </Tooltip>
 579 |           <RenameTitle
 580 |             title={info.title}
 581 |             onRename={(t) => client.renameSession(info.id, t)}
 582 |           />
 583 |           <PaneTaskChip task={info.task} />
 584 |           <PaneWatchChip watches={prWatches} />
 585 |           <BranchChip checkout={(info as CheckoutOf).checkout} remoteHost={info.ssh_host} worktreeChildren={worktreeChildren} />
 586 |           <PaneHeaderTags tagIds={info.tags} />
 587 |           {info.acp != null && <AcpBadge slug={info.acp} />}
 588 |           {info.profile_label != null && <ProfileBadge label={info.profile_label} />}
 589 |           {showProject && (
 590 |             <PaneSubtitle data-testid="pane-sub" className="[@container_(max-width:400px)]:hidden">
 591 |               · {info.agent === 'ssh' && info.ssh_host ? info.ssh_host : basename(info.project_dir)}
 592 |             </PaneSubtitle>
 593 |           )}
 594 |         </PaneHeadIdentity>
 595 |         <SessionInboxButton info={info} />
 596 |         <SessionHeaderActions info={info} client={client} ended={ended} live={live} expanded={expanded} shellIntegration={shellIntegration} onReconnectSsh={onReconnectSsh} onExpand={onExpand} onAddPane={onAddPane} menuOpen={menu !== null} closeMenu={closeMenu} openMenuAtButton={openMenuAtButton} />
 597 |       </PaneHeader>
```

### `ui/src/renderer/src/components/SessionPane.tsx:816`

```tsx
 816 | function SessionHeaderStatusDot({ info, live }: { info: SessionInfo; live: boolean }): React.JSX.Element {
 817 |   const delegating = useSessionsSelector(useCallback((sessions) => hasWorkingDescendant(info.id, sessions.values()), [info.id]), Object.is, false)
 818 |   if (info.spawned_by != null) return <ChildStatusDot info={info} />
 819 |   const status = info.children_waiting > 0 ? 'needs-input' : info.status === 'idle' && delegating ? 'working' : info.status
 820 |   return <StatusDot status={status} live={live || info.children_waiting > 0} />
 821 | }
 822 | 
 823 | function SessionInboxButton({ info }: { info: SessionInfo }): React.JSX.Element | null {
 824 |   if (!(info.inbox_unread > 0)) return null
 825 |   const label = `${info.inbox_unread} unread inbox messages`
 826 |   return <Tooltip label={label}><Button variant="ghost" size="sm" aria-label={label} className="flex-none" onClick={() => openSideOverview(info.id)}>Inbox<Count value={info.inbox_unread} /></Button></Tooltip>
 827 | }
 828 | 
 829 | function SessionHeaderActions({ info, client, ended, live, expanded, shellIntegration, onReconnectSsh, onExpand, onAddPane, menuOpen, closeMenu, openMenuAtButton }: Pick<Props, 'info' | 'client' | 'expanded' | 'shellIntegration' | 'onReconnectSsh' | 'onExpand' | 'onAddPane'> & {
 830 |   ended: string | null
 831 |   live: boolean
 832 |   menuOpen: boolean
 833 |   closeMenu: () => void
 834 |   openMenuAtButton: (rect: DOMRect) => void
 835 | }): React.JSX.Element {
 836 |   return (<PaneHeadActions>
 837 |           <ContextIndicator context={info.context} />
 838 |           {ended && (
 839 |             <PaneStateChip data-testid="pane-state" className="[@container_(max-width:490px)]:hidden" state={info.state}>
 840 |               {ended}
 841 |             </PaneStateChip>
 842 |           )}
 843 |           {!live && (
 844 |             <Tooltip
 845 |               label={info.state === 'sleeping' ? 'Wake conversation' : restartTooltip(info)}
 846 |             >
 847 |               <PaneHeadButton
 848 |                 aria-label={info.state === 'sleeping' ? 'Wake conversation' : info.agent === 'ssh' ? 'Reconnect' : 'Restart'}
 849 |                 onClick={(e) => {
 850 |                   e.stopPropagation()
 851 |                   if (info.agent === 'ssh') onReconnectSsh(info.id)
 852 |                   else if (info.state === 'sleeping') client.send({ type: 'session_wake', session: info.id })
 853 |                   else client.respawnSession(info.id, shellIntegration)
 854 |                 }}
 855 |               >
 856 |                 <Icon glyph={IconRespawn} role="ui" />
 857 |               </PaneHeadButton>
 858 |             </Tooltip>
 859 |           )}
 860 |           <Tooltip label="Terminal actions">
 861 |             <PaneHeadButton
 862 |               tone="accent"
 863 |               aria-label="Terminal actions"
 864 |               onMouseDown={(e) => e.stopPropagation()}
 865 |               onClick={(e) => {
 866 |                 e.stopPropagation()
 867 |                 if (menuOpen) {
 868 |                   closeMenu()
 869 |                 } else {
 870 |                   openMenuAtButton(e.currentTarget.getBoundingClientRect())
 871 |                 }
 872 |               }}
 873 |             >
 874 |               <IconEllipsis className={HEAD_ICON_CLS} />
 875 |             </PaneHeadButton>
 876 |           </Tooltip>
 877 |           <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
 878 |             <PaneHeadButton
 879 |               tone={expanded ? 'info' : 'regular'}
 880 |               className="[@container_(max-width:150px)]:hidden"
 881 |               aria-label={expanded ? 'Collapse' : 'Expand'}
 882 |               aria-pressed={expanded}
 883 |               onClick={(e) => {
 884 |                 e.stopPropagation()
 885 |                 onExpand(info.id)
 886 |               }}
 887 |             >
 888 |               {expanded ? <IconMinimize className={HEAD_ICON_CLS} /> : <IconMaximize className={HEAD_ICON_CLS} />}
 889 |             </PaneHeadButton>
 890 |           </Tooltip>
 891 |           {onAddPane && (
 892 |             <Tooltip label="New pane">
 893 |               <PaneHeadButton
 894 |                 tone="accent"
 895 |                 aria-label="New pane"
 896 |                 onClick={(e) => {
 897 |                   e.stopPropagation()
 898 |                   onAddPane(info.id, e.currentTarget.getBoundingClientRect())
 899 |                 }}
 900 |               >
 901 |                 <IconPlus className={HEAD_ICON_CLS} />
 902 |               </PaneHeadButton>
 903 |             </Tooltip>
 904 |           )}
 905 |           <Tooltip label={live ? 'Close (stops the agent)' : 'Close'}>
 906 |             <PaneHeadButton
 907 |               tone="danger"
 908 |               aria-label="Close"
 909 |               onClick={(e) => {
 910 |                 e.stopPropagation()
 911 |                 client.closeSession(info.id)
 912 |               }}
 913 |             >
 914 |               <Icon glyph={IconClose} role="ui" />
 915 |             </PaneHeadButton>
 916 |           </Tooltip>
 917 |         </PaneHeadActions>)
 918 | }
 919 | 
 920 | function ChildrenRoom({ info, children, roster, client, peek, selectChild, moveChild, mode, onMode, terminals }: Pick<Props, 'info' | 'roster' | 'client'> & {
```

### `ui/src/renderer/src/components/StackTabs.tsx:1`

```tsx
   1 | import { useSessionsSelector, shallowArrayEqual } from '../sessionsStore'
   2 | import type { SessionInfo } from '../houston/client'
   3 | import { isLive } from '../houston/client'
   4 | import type { PaneNode, PaneKey, StackNode } from '../layout/tree'
   5 | import { paneKey } from '../layout/tree'
   6 | import { useStackCapacity } from '../paneCaps'
   7 | import { StatusDot } from './SessionPane'
   8 | import { PANE_TYPES } from '../layout/paneTypes'
   9 | import { IconClose } from './icons'
  10 | import { Tooltip } from './ui/Tooltip'
  11 | import { Icon } from './ui/Icon'
  12 | import { StackTab, StackTabBadge, StackTabCapacity, StackTabClose, StackTabLabel, StackTabStrip } from './ui/StackTab'
  13 | 
  14 | function tabLabel(node: PaneNode, sessions: Map<number, SessionInfo>): string {
  15 |   if (node.kind === 'leaf') return sessions.get(node.session)?.title ?? 'Terminal'
  16 |   return PANE_TYPES.find((t) => t.kind === node.kind)?.label ?? node.kind
  17 | }
  18 | 
  19 | function tabNeedsInputInBackground(
  20 |   node: PaneNode,
  21 |   sessions: Map<number, SessionInfo>,
  22 |   isActiveTab: boolean
  23 | ): boolean {
  24 |   if (isActiveTab || node.kind !== 'leaf') return false
  25 |   const info = sessions.get(node.session)
  26 |   return !!info && isLive(info.state) && info.status === 'needs-input'
  27 | }
  28 | 
  29 | interface Props {
  30 |   stack: StackNode
  31 |   displayedIndex: number
  32 |   sessions: Map<number, SessionInfo>
  33 |   onSelect: (key: PaneKey) => void
  34 |   onUnstack: (key: PaneKey) => void
  35 | }
  36 | 
  37 | export function StackTabs({
  38 |   stack,
  39 |   displayedIndex,
  40 |   sessions: sessionsProp,
  41 |   onSelect,
  42 |   onUnstack
  43 | }: Props): React.JSX.Element {
  44 |   const members = useSessionsSelector(
  45 |     (sessions) => stack.children.flatMap((child) => child.kind === 'leaf' ? sessions.get(child.session) ?? [] : []),
  46 |     shallowArrayEqual,
  47 |     [...sessionsProp.values()],
  48 |   )
  49 |   const sessions = new Map(members.map((session) => [session.id, session]))
  50 |   const cap = useStackCapacity()
  51 |   const full = stack.children.length >= cap
  52 |   return (
  53 |     <StackTabStrip data-testid="stack-tabs">
  54 |       {stack.children.map((child, i) => {
  55 |         const key = paneKey(child)
  56 |         const active = i === displayedIndex
  57 |         const badge = tabNeedsInputInBackground(child, sessions, active)
  58 |         const info = child.kind === 'leaf' ? sessions.get(child.session) : undefined
  59 |         return (
  60 |           <StackTab
  61 |             key={String(key)}
  62 |             active={active}
  63 |             data-testid="stack-tab"
  64 |             data-active={active}
  65 |             data-needs-input-badge={badge}
  66 |             role="tab"
  67 |             aria-selected={active}
  68 |             tabIndex={0}
  69 |             onClick={() => onSelect(key)}
  70 |             onKeyDown={(e) => {
  71 |               if (e.key === 'Enter' || e.key === ' ') onSelect(key)
  72 |             }}
  73 |           >
  74 |             {info && <StatusDot status={info.status} live={isLive(info.state)} />}
  75 |             <StackTabLabel>{tabLabel(child, sessions)}</StackTabLabel>
  76 |             {badge && (
  77 |               <Tooltip label="Needs your input — hidden behind this stack's active tab">
  78 |                 <StackTabBadge data-testid="stack-tab-badge" aria-label="needs your input" />
  79 |               </Tooltip>
  80 |             )}
  81 |             <Tooltip label="Remove from stack">
  82 |               <StackTabClose
  83 |                 type="button"
  84 |                 aria-label={`Remove ${tabLabel(child, sessions)} from stack`}
  85 |                 onClick={(e) => {
  86 |                   e.stopPropagation()
  87 |                   onUnstack(key)
  88 |                 }}
  89 |               >
  90 |                 <Icon glyph={IconClose} role="label" />
  91 |               </StackTabClose>
  92 |             </Tooltip>
  93 |           </StackTab>
  94 |         )
  95 |       })}
  96 |       {full && (
  97 |         <Tooltip label={`Stack is full (${stack.children.length}/${cap})`}>
  98 |           <StackTabCapacity data-testid="stack-full-indicator">
  99 |             {stack.children.length}/{cap}
 100 |           </StackTabCapacity>
 101 |         </Tooltip>
 102 |       )}
 103 |     </StackTabStrip>
 104 |   )
 105 | }
```

### `ui/src/renderer/src/components/NewSessionComposer.tsx:130`

```tsx
 130 |   const sessionWord = count === 1 ? 'session' : 'sessions'
 131 | 
 132 |   return (
 133 |     <DockedFormPanel data-testid="new-session-composer">
 134 |       <LaunchComposerHeader workspaceName={workspaceName} workspacePath={workspacePath} gridName={gridName} target={target} onClose={onCancel} />
 135 | 
 136 |       <ScrollableFormBody>
 137 |         <Segmented aria-label="Launch target" leadingLabel="Launch into" value={target} onChange={setTarget} options={[
 138 |             { value: 'this-grid', label: 'This grid', testId: 'launch-target-this-grid' },
 139 |             { value: 'new-grid', label: 'New grid', testId: 'launch-target-new-grid' }
 140 |           ]} className="w-full" />
 141 |         <OptionFieldset legend="Preset">
 142 |           <PresetGrid>
 143 |             {SESSION_PRESETS.map((p) => {
 144 |               const selected = presetId === p.id
 145 |               return (
 146 |                 <LaunchPresetCard
 147 |                   key={p.id}
 148 |                   id={p.id}
 149 |                   name={p.name}
 150 |                   blurb={p.blurb}
 151 |                   count={p.count}
 152 |                   selected={selected}
 153 |                   onSelect={() => choosePreset(p)}
 154 |                   onPreviewStart={() => setHoveredPreset(p.id)}
 155 |                   onPreviewEnd={() => setHoveredPreset(null)}
 156 |                 />
 157 |               )
 158 |             })}
 159 |           </PresetGrid>
 160 |         </OptionFieldset>
 161 | 
 162 |         <InlineControlRow>
 163 |           <LabeledControl as="label" label="Default agent" className="min-w-0">
 164 |             <Select aria-label="Default agent" value={agent} options={COMPOSER_AGENTS.map((value) => ({ value, label: AGENT_LABEL[value] ?? value }))}
 165 |               onChange={(value) => { setAgent(value as AgentKind); setAgentOverridden(true) }} />
 166 |           </LabeledControl>
 167 |           <LabeledControl as="group" label="How many">
 168 |             <CountStepper value={count} min={1} max={MAX_COUNT} onChange={setCount} />
 169 |           </LabeledControl>
 170 |         </InlineControlRow>
 171 | 
 172 |         <FormSection>
 173 |           <SectionHeading>Slots</SectionHeading>
 174 |           <SlotList data-testid="new-session-preview">
 175 |             {slots.map((s) => (
 176 |               <LaunchSlotCard key={s.index} slot={s} workspaceName={workspaceName} override={overrides[s.index] ?? {}}
 177 |                 onAgentChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], agent: value } }))}
 178 |                 onModelChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], model: value } }))}
 179 |                 onEffortChange={(value) => setOverrides((current) => ({ ...current, [s.index]: { ...current[s.index], effort: value } }))}
 180 |                 onReset={() => setOverrides((current) => { const next = { ...current }; delete next[s.index]; return next })} />
 181 |             ))}
 182 |           </SlotList>
 183 |         </FormSection>
 184 | 
 185 |         <FieldGroup>
 186 |           <FormLabel htmlFor="new-session-task">
 187 |             Task — goes to every agent, optional
 188 |           </FormLabel>
 189 |           <TaskInput
 190 |             id="new-session-task"
 191 |             data-testid="new-session-task"
 192 |             rows={1}
 193 |             value={task}
 194 |             onChange={(e) => setTask(e.target.value)}
 195 |             placeholder={count === 1 ? 'What should it work on?' : 'What should they work on?'}
 196 |           />
 197 |           {overLimit && (
 198 |             <FieldError role="alert" data-testid="new-session-task-error">
 199 |               {overLimit}
 200 |             </FieldError>
 201 |           )}
 202 |           <FieldCounter>
 203 |             {taskByteLength(task).toLocaleString('en-US')} / 8,192 bytes
 204 |           </FieldCounter>
 205 |         </FieldGroup>
 206 | 
 207 |         <FormSection aria-label="Workspace routing">
 208 |           <div className="flex items-center justify-between gap-[var(--space-2)]">
 209 |             <SectionHeading>Workspace routing</SectionHeading>
 210 |             <Chip variant="state" label="Houston" />
 211 |           </div>
 212 |           {routes.length === 0
 213 |             ? <RouteNote>No routes · agents use their defaults</RouteNote>
 214 |             : <RouteList>{routes.map((route, index) => <RouteNote key={`${route.pattern}-${index}`}>{route.pattern} → {route.model}{route.effort ? ` · ${route.effort}` : ''}</RouteNote>)}</RouteList>}
 215 |         </FormSection>
 216 |       </ScrollableFormBody>
 217 | 
 218 |       <ActionFooter>
 219 |         <InlineSummary data-testid="new-session-summary">
 220 |           {preset?.name ?? 'Custom'} · {count} {sessionWord} in {workspaceName}
 221 |         </InlineSummary>
 222 |         <PrimaryAction data-testid="new-session-launch" disabled={!canLaunch} onClick={() => onLaunch(slots, target)}>
 223 |           Launch {slots.length} {sessionWord} <small>Ctrl ↵</small>
 224 |         </PrimaryAction>
 225 |       </ActionFooter>
 226 |     </DockedFormPanel>
 227 |   )
 228 | }
```

### `ui/src/renderer/src/railPrefs.ts:33`

```tsx
  33 | export const DETAILED_DEFAULT: RailCardProperty[] = [
  34 |   'status',
  35 |   'unread',
  36 |   'checkout',
  37 |   'pr',
  38 |   'diff',
  39 |   'task',
  40 |   'inline-agents',
  41 | ]
  42 | export const COMPACT_DEFAULT: RailCardProperty[] = ['status', 'unread']
  43 | 
  44 | export const DEFAULT_RAIL_PREFS: RailPrefs = {
  45 |   v: 1,
  46 |   groupBy: 'workspace',
  47 |   sort: 'manual',
  48 |   cardMode: 'detailed',
  49 |   tagDisplay: 'icon',
  50 |   agentActivity: 'compact',
  51 |   properties: [...DETAILED_DEFAULT],
  52 |   filters: { hideIdle: false, hideDefaultBranch: false, hideEmptyGrids: false },
  53 |   collapsedGroups: [],
  54 |   tags: [],
  55 |   customisedProperties: false,
  56 |   gridOrder: [],
  57 |   gridUnreadOverrides: {},
  58 | }
```

### `ui/src/renderer/src/components/rail/railCardModel.ts:90`

```tsx
  90 |   const branches = source.branches ?? new Map<number, string>()
  91 |   const panes = orderGridPanes(source.sessions, source.paneIds).map((pane) => ({ ...pane, session: liftDelegatedWork(pane.session, source.sessions) }))
  92 |   const checkouts: CheckoutIdentity[] = []
  93 |   const checkoutKeys = new Set<string>()
  94 |   const agents = panes.map(({ session, depth }): RailAgentRow => {
  95 |     const checkout = checkoutIdentity(session, branches)
  96 |     const checkoutKey = checkout.kind === 'remote' ? `remote:${checkout.host}` : `${checkout.kind}:${checkout.root}`
  97 |     if (!checkoutKeys.has(checkoutKey)) {
  98 |       checkoutKeys.add(checkoutKey)
  99 |       checkouts.push(checkout)
 100 |     }
 101 |     const activity = activityOf(session)
 102 |     const leading = activity?.prompt?.trim() || session.title || session.agent
 103 |     return {
 104 |       session,
 105 |       agent: session.agent === 'shell' ? (session.running_agent ?? 'shell') : session.agent,
 106 |       depth,
 107 |       checkout,
 108 |       leading,
 109 |       trailing: activity?.last_message?.trim() || null,
 110 |       model: activity?.model ?? null,
 111 |       unread: session.inbox_unread > 0 || session.children_waiting > 0,
 112 |     }
 113 |   })
 114 |   const primaryPaneId = panes[0]?.session.id
 115 |   const primaryCheckout = primaryPaneId == null ? null : checkouts[0]
 116 |   const checkoutRoot = primaryCheckout && 'root' in primaryCheckout ? primaryCheckout.root : null
 117 |   const status = gridStatus(panes.map(({ session }) => session))
```

### `ui/src/renderer/src/scmPanel.ts:128`

```tsx
 128 | export interface InspectorTabsState { openTabs: SurfaceKind[]; active: SurfaceKind | null }
 129 | const INSPECTOR_TABS_PREFIX = 'tr-inspector-tabs:'
 130 | const LEGACY_INSPECTOR_TAB_PREFIX = 'tr-inspector-tab:'
 131 | const SURFACES: SurfaceKind[] = ['browser', 'files', 'diff', 'pull-request', 'linked-pull-requests']
 132 | 
 133 | export function loadInspectorTabs(workspace: string): InspectorTabsState {
 134 |   const fallback: InspectorTabsState = { openTabs: [], active: null }
 135 |   try {
 136 |     const raw = localStorage.getItem(INSPECTOR_TABS_PREFIX + workspace)
 137 |     if (raw !== null) {
 138 |       const parsed = JSON.parse(raw) as Partial<InspectorTabsState>
 139 |       if (!Array.isArray(parsed.openTabs)) return fallback
 140 |       const openTabs = parsed.openTabs.filter(
 141 |         (tab, index, all): tab is SurfaceKind =>
 142 |           SURFACES.includes(tab as SurfaceKind) && all.indexOf(tab) === index,
 143 |       )
 144 |       const active = SURFACES.includes(parsed.active as SurfaceKind) && openTabs.includes(parsed.active as SurfaceKind)
 145 |         ? parsed.active as SurfaceKind
 146 |         : openTabs.at(-1) ?? null
 147 |       return { openTabs, active }
 148 |     }
 149 |     const legacy = localStorage.getItem(LEGACY_INSPECTOR_TAB_PREFIX + workspace)
 150 |     const migrated: SurfaceKind | null = legacy === 'files'
 151 |       ? 'files'
 152 |       : legacy === 'pull-request'
 153 |         ? 'pull-request'
 154 |         : legacy === 'changes' ? 'diff' : null
 155 |     return migrated ? { openTabs: [migrated], active: migrated } : fallback
 156 |   } catch { return fallback }
 157 | }
 158 | 
```

### `ui/src/renderer/src/components/SidePanel.tsx:42`

```tsx
  42 | function pullRequestTone(link: PullRequestLink | undefined): 'stop' | 'warn' | 'ok' | null {
  43 |   if (!link) return null
  44 |   if (link.checks === 'failing') return 'stop'
  45 |   if (link.checks === 'running') return 'warn'
  46 |   return 'ok'
  47 | }
  48 | 
  49 | const SURFACE_META: Record<SurfaceKind, { label: string; shortcut: string; description: string; icon: React.ReactNode }> = {
  50 |   browser: { label: 'Browser', shortcut: 'B', description: 'Browse local pages', icon: <Icon glyph={IconGlobe} role="label" /> },
  51 |   files: { label: 'Files', shortcut: 'F', description: 'Browse and edit workspace files', icon: <PanelFilesIcon /> },
  52 |   diff: { label: 'Diff', shortcut: 'D', description: 'Review working tree changes', icon: <PanelDiffIcon /> },
  53 |   'pull-request': { label: 'Pull request', shortcut: 'P', description: 'Review this branch’s pull request', icon: <Icon glyph={IconGitPullRequest} role="label" /> },
```

### `ui/src/renderer/src/base.css:1`

```tsx
   1 | * {
   2 |   box-sizing: border-box;
   3 | }
   4 | html,
   5 | body,
   6 | #root {
   7 |   margin: 0;
   8 |   height: 100vh;
   9 |   overflow: hidden;
  10 |   background: var(--content-bg);
  11 |   color: var(--text-primary);
  12 |   font-family: var(--font-sans);
  13 |   font-weight: 500;
  14 |   -webkit-font-smoothing: antialiased;
  15 |   -moz-osx-font-smoothing: grayscale;
  16 | }
  17 | body {
  18 |   font-size: var(--tr-text-base);
  19 | }
  20 | * {
  21 |   scrollbar-width: thin;
  22 |   scrollbar-color: color-mix(in srgb, var(--border) 55%, transparent) transparent;
  23 | }
  24 | ::-webkit-scrollbar {
  25 |   width: 6px;
  26 |   height: 6px;
  27 | }
  28 | ::-webkit-scrollbar-track {
  29 |   background: transparent;
  30 | }
  31 | ::-webkit-scrollbar-thumb {
  32 |   background: transparent;
  33 |   border-radius: calc(var(--tr-radius-sm) / 2);
  34 | }
  35 | *:hover::-webkit-scrollbar-thumb {
  36 |   background: var(--border);
  37 | }
  38 | ::-webkit-scrollbar-thumb:hover {
  39 |   background: var(--border-hover);
  40 | }
  41 | 
  42 | @layer base {
  43 |   button {
  44 |     font: inherit;
  45 |     cursor: pointer;
  46 |     color: var(--text-primary);
  47 |     white-space: nowrap;
  48 |   }
  49 |   button:disabled {
  50 |     opacity: 0.45;
  51 |     cursor: not-allowed;
  52 |   }
  53 | 
  54 |   button:focus-visible,
  55 |   select:focus-visible,
  56 |   input:focus-visible {
  57 |     outline: 2px solid var(--accent);
  58 |     outline-offset: 1px;
  59 |   }
```

### `ui/src/renderer/src/tailwind.css:1`

```tsx
   1 | @layer properties, theme, base, components, utilities;
   2 | 
   3 | @import 'tailwindcss/theme.css' layer(theme);
   4 | @import 'tailwindcss/preflight.css' layer(base);
   5 | @import 'tailwindcss/utilities.css' layer(utilities);
   6 | 
   7 | @source '.';
   8 | @source './components/ui';
   9 | @source not './**/*.test.ts';
  10 | @source not './**/*.test.tsx';
  11 | 
  12 | /* Registers Houston's semantic colour names as Tailwind tokens; deleting this
  13 |    block silently drops every `bg-surface`/`text-primary` utility from the
  14 |    build. The `var()` values only cover the pre-theme-attribute paint gap. */
  15 | @theme {
  16 |   --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace;
  17 | 
  18 |   --text-3xl--line-height: 1.2;
  19 | 
  20 |   --color-surface: var(--surface);
  21 |   --color-surface-hover: var(--surface-hover);
  22 |   --color-surface-active: var(--surface-active);
  23 |   --color-background: var(--background);
  24 |   --color-panel: var(--panel);
  25 |   --color-border: var(--border);
  26 |   --color-border-hover: var(--border-hover);
  27 |   --color-border-active: var(--border-active);
  28 |   --color-popover: var(--popover);
  29 |   --color-popover-foreground: var(--popover-foreground);
  30 |   --color-text-primary: var(--text-primary);
  31 |   --color-text-secondary: var(--text-secondary);
  32 |   --color-text-muted: var(--text-muted);
  33 |   --color-primary: var(--primary);
  34 |   --color-primary-foreground: var(--primary-foreground);
  35 |   --color-secondary: var(--secondary);
  36 |   --color-muted: var(--muted);
  37 |   --color-accent: var(--accent-surface);
  38 |   --color-accent-foreground: var(--accent-foreground);
  39 |   --color-info: var(--info);
  40 |   --color-success: var(--success);
  41 |   --color-warning: var(--warning);
  42 |   --color-danger: var(--danger);
  43 |   --color-selection: var(--selection);
  44 |   --color-selected-fill: var(--selected-fill);
  45 |   --color-hover-fill: var(--hover-fill);
  46 |   --color-elevated-surface: var(--elevated-surface);
  47 |   --color-overlay: var(--overlay);
  48 |   --color-focus-ring: var(--focus-ring);
  49 |   --color-divider: var(--divider);
  50 |   --color-border-focus: var(--border-focus);
  51 | }
  52 | 
  53 | @keyframes git-spin {
  54 |   to {
  55 |     transform: rotate(360deg);
  56 |   }
  57 | }
```

### `ui/src/renderer/src/main.tsx:1`

```tsx
   1 | import { MascotAppRoot } from './mascot/MascotAppRoot'
   2 | import { MascotSurfaceMount } from './mascot/MascotMount'
   3 | import React from 'react'
   4 | import ReactDOM from 'react-dom/client'
   5 | import { ROOT_CRASH_GUARANTEE, ROOT_CRASH_TITLE } from './components/crashCopy'
   6 | import '@fontsource/plus-jakarta-sans/400.css'
   7 | import '@fontsource/plus-jakarta-sans/500.css'
   8 | import '@fontsource/plus-jakarta-sans/600.css'
   9 | import '@fontsource/plus-jakarta-sans/700.css'
  10 | import '@fontsource/jetbrains-mono/400.css'
  11 | import '@fontsource/jetbrains-mono/500.css'
  12 | import '@fontsource/jetbrains-mono/700.css'
  13 | import '@fontsource/source-serif-4/400.css'
  14 | import '@fontsource/source-serif-4/500.css'
  15 | import '@fontsource/source-serif-4/600.css'
  16 | import { App } from './App'
  17 | import { BootstrapGate } from './BootstrapGate'
  18 | import { Button, FullScreenMessage } from './components/ui'
  19 | import { recordAndReload, reloadStormDetected, resetReloadBudget } from './reloadBudget'
  20 | import { installWatchdog } from './watchdog'
  21 | import { installNativeFileDrop } from './houston/nativeFileDrop'
  22 | import { WindowResizeGrips } from './components/WindowResizeGrips'
```

### `ui/src/renderer/src/keyframes.css:88`

```tsx
  88 | @keyframes dot-pulse {
  89 |   0%,
  90 |   100% {
  91 |     opacity: 1;
  92 |   }
  93 |   50% {
  94 |     opacity: var(--dot-pulse-opacity, 1);
  95 |   }
  96 | }
  97 | 
```

## UI primitive file inventory

`ActionEmptyState.tsx` `ActionMenu.tsx` `ActivityDot.tsx` `AgentOptionGrid.tsx` `AgentSummaryPill.tsx` `AnimOut.tsx` `AppTitlebar.tsx` `AttachmentChipParts.tsx` `BackdropLayer.tsx` `BackgroundField.tsx` `BarSparkline.tsx` `Block.tsx` `Branch.tsx` `BrowserActSurface.tsx` `BrowserButtonRoles.tsx` `BrowserPaneStates.tsx` `BrowserSurface.tsx` `Button.tsx` `ButtonRecipe.tsx` `Callout.tsx` `Caption.tsx` `Card.tsx` `ChangeSummary.tsx` `Changes.tsx` `Checkbox.tsx` `CheckedStamp.tsx` `Checkpoint.tsx` `ChildPaneLayout.tsx` `Chip.tsx` `ChoiceCard.tsx` `ChoiceTile.tsx` `CommandPalette.tsx` `ComposerPill.tsx` `ConfigurationDetail.tsx` `ConfirmDialog.tsx` `ConnectionBanner.tsx` `ConnectionCell.tsx` `ContentRegion.tsx` `ContentSection.tsx` `ContentsSwitch.tsx` `ContextMenu.tsx` `ContextMeter.tsx` `CopyChip.tsx` `Count.tsx` `DataTable.tsx` `DefinitionTable.tsx` `DelegationButtonRoles.tsx` `DelimitedTable.tsx` `DetailsDisclosure.tsx` `DevBadge.tsx` `Dialog.tsx` `DictationIndicator.tsx` `Diff.tsx` `DiffLoadingMark.tsx` `Disclosure.tsx` `DiscussionEntry.tsx` `Drawer.tsx` `EditorContextMenu.tsx` `EditorDirtyIndicator.tsx` `EditorHeaderButton.tsx` `EditorPreview.tsx` `EditorSurface.tsx` `EmptyGridHint.tsx` `EmptyState.tsx` `Field.tsx` `FileAttachmentRow.tsx` `FileExplorer.tsx` `FilePanelMessage.tsx` `FilesSurfaceElement.tsx` `FirstRunHooksStep.tsx` `FloatingBanner.tsx` `FontSizeControl.tsx` `FormGrid.tsx` `FullScreenMessage.tsx` `GitStatusMark.tsx` `GridRailContextActions.tsx` `GridRailExtraActions.tsx` `GridRailHoverCard.tsx` `GridRailRow.tsx` `GridRailRowFallback.tsx` `GridRegion.tsx` `GridSlot.tsx` `HistoryEditor.tsx` `HookPanel.tsx` `HookStatus.tsx` `Icon.tsx` `IconTile.tsx` `Inline.tsx` `InlineLink.tsx` `InlineNotice.tsx` `InlineText.tsx` `InsetPanel.tsx` `InspectorHeader.tsx` `IntegrationCard.tsx` `KeyCap.tsx` `KeymapHint.tsx` `LaunchComposerHeader.tsx` `LaunchComposerParts.tsx` `LaunchGridPreview.tsx` `LaunchLayoutPreview.tsx` `LaunchPresetCard.tsx` `LaunchSlotCard.tsx` `LaunchWorkspaceBadge.tsx` `LauncherRow.tsx` `LazyLegacyButtonRoles.tsx` `LevelThresholdControl.tsx` `License.tsx` `ListDetail.tsx` `MarkdownContent.tsx` `MarkdownImage.tsx` `MarkdownToggle.tsx` `MascotArt.tsx` `MascotDockSlot.tsx` `MascotGame.tsx` `MascotIntro.tsx` `MascotRig.tsx` `MascotSurface.tsx` `MaterialSurface.tsx` `Menu.tsx` `MenuItem.tsx` `MetadataRow.tsx` `MonoBlock.tsx` `NavListDetail.tsx` `NavSurfaceFrame.tsx` `NavigationRail.tsx` `NavigationRailCompanion.tsx` `NavigationRailFooter.tsx` `Notice.tsx` `NoticeToast.tsx` `NumberField.tsx` `OnboardingStage.tsx` `OpenInSubmenu.tsx` `OptionCandidateList.tsx` `OrchestrationNotice.tsx` `OrchestratorOverview.tsx` `OverviewButtonRoles.tsx` `PageFrame.tsx` `PageHeader.tsx` `PaletteOptions.tsx` `PaneContextMenu.tsx` `PaneControls.tsx` `PaneDropIndicator.tsx` `PaneFocus.tsx` `PaneFrame.tsx` `PaneHeader.tsx` `PaneHeaderButton.tsx` `PaneMenu.tsx` `PaneMenuRow.tsx` `PaneTitle.tsx` `PaneView.tsx` `PanelControls.tsx` `PanelInlineControls.tsx` `PanelTab.tsx` `PopoverPanel.tsx` `PopoverViews.tsx` `PrDetailSkeleton.tsx` `PrInspectorSections.tsx` `PrLink.tsx` `PrTab.tsx` `PrWatch.tsx` `ProfilePanel.tsx` `ProgressSteps.tsx` `Prose.tsx` `PullRequestActions.tsx` `PullRequestDiff.tsx` `PullRequestLabel.tsx` `PullRequestPickers.tsx` `PullRequestRoles.tsx` `PullRequestState.tsx` `QuestionOption.tsx` `QuietButton.tsx` `RadioCard.tsx` `Readout.tsx` `RepositoryBrowser.tsx` `ResizeHandle.tsx` `ReviewButtonRoles.tsx` `ReviewDiffLine.tsx` `ReviewSubmission.tsx` `RosterSurface.tsx` `RoutineDetail.tsx` `SaveStateMark.tsx` `ScmNotice.tsx` `ScreenRegion.tsx` `SectionHead.tsx` `Segmented.tsx` `SegmentedControl.tsx` `Select.tsx` `SettingsBreadcrumb.tsx` `SettingsButtonRoles.tsx` `SettingsDetail.tsx` `SettingsPageSurface.tsx` `SettingsProtocol.tsx` `SettingsRailRow.tsx` `SettingsScope.tsx` `SettingsSearch.tsx` `SettingsStatus.tsx` `SettingsTextarea.tsx` `ShellPrimitives.tsx` `ShortcutControls.tsx` `ShortcutGroupLabel.tsx` `ShortcutHint.tsx` `SidePanelRow.tsx` `SingleLineText.tsx` `Slider.tsx` `SourceControl.tsx` `SplitButton.tsx` `Stack.tsx` `StackLayerList.tsx` `StackTab.tsx` `StartupFailure.tsx` `StartupSkeleton.tsx` `StatusIcon.tsx` `StatusLabel.tsx` `StatusNote.tsx` `SurfaceCrash.tsx` `Switch.tsx` `Table.tsx` `TagChip.tsx` `TagList.tsx` `TagSwatch.tsx` `TaskDescriptionPreview.tsx` `TaskKeyChip.tsx` `TaskPagePrimitives.tsx` `TaskProgress.tsx` `TaskRunSurface.tsx` `TaskSettingDetails.tsx` `TaskSurface.tsx` `TerminalDropzone.tsx` `TerminalFind.tsx` `TerminalHost.tsx` `TerminalPalettePicker.tsx` `TerminalSkeleton.tsx` `Text.tsx` `TextArea.tsx` `TextInput.tsx` `ThemePaletteTable.tsx` `ThemeRevealSpecimen.tsx` `Timeline.tsx` `TitleEditControls.tsx` `ToolbarActions.tsx` `Tooltip.tsx` `UsageCalendar.tsx` `UsageChart.tsx` `UsageChrome.tsx` `UsageModelCell.tsx` `UsageProviderRow.tsx` `UsageSectionHeading.tsx` `UsageShareBar.tsx` `VersionBadge.tsx` `VersionTag.tsx` `Viewport.tsx` `WindowControl.tsx` `WindowControlDock.tsx` `WorkspaceActions.tsx` `WorkspaceGroupLabel.tsx` `WorkspaceTreeRow.tsx` `formPrimitives.tsx` `navPrimitives.tsx` `navRow.tsx` `navText.tsx` `settingsPrimitives.tsx` 

## Harness story keys

- `ui/src/renderer/harness/inspectorStories.tsx:84`: `const title = merged ? 'fix(codex): Codex panes start again with Codex CLI 0.160' : 'fix(panes): terminals keep their content while the inspector opens'`
- `ui/src/renderer/harness/railStories.tsx:462`: `'rail/card-modes': () => <RailCardModes />,`
- `ui/src/renderer/harness/railStories.tsx:463`: `'rail/card-modes-options': () => <RailCardModes openOptions />,`
- `ui/src/renderer/harness/railStories.tsx:464`: `'rail/card-modes-options-sort': () => <RailCardModes optionsPanel="sort" />,`
- `ui/src/renderer/harness/railStories.tsx:465`: `'rail/card-modes-options-display': () => <RailCardModes optionsPanel="display" />,`
- `ui/src/renderer/harness/railStories.tsx:466`: `'rail/card-modes-tags-dots': () => <RailCardModes tagDisplay="dots" />,`
- `ui/src/renderer/harness/railStories.tsx:467`: `'rail/card-modes-tags-chips': () => <RailCardModes tagDisplay="chips" />,`
- `ui/src/renderer/harness/railStories.tsx:468`: `'rail/card-modes-tags-filtered': () => <RailCardModes tagDisplay="dots" tagFilter={[1, 2]} openOptions />,`
- `ui/src/renderer/harness/railStories.tsx:469`: `'rail/card-modes-hover': () => <RailCardModes hoverCard />,`
- `ui/src/renderer/harness/railStories.tsx:470`: `'rail/card-modes-expanded': () => <RailCardModes expandAgents />,`
- `ui/src/renderer/harness/railStories.tsx:471`: `'rail/card-modes-condensed': () => <RailCardModes initialCompact />,`
- `ui/src/renderer/harness/railStories.tsx:472`: `'rail/card-modes-tag-popover': () => <RailCardModes openTagPopover />,`
- `ui/src/renderer/harness/railStories.tsx:473`: `'rail/states': () => <RailFixture />,`
- `ui/src/renderer/harness/railStories.tsx:474`: `'rail/states-paper': () => <RailFixture chromeTheme="paper" />,`
- `ui/src/renderer/harness/railStories.tsx:475`: `'rail/tag-filter-active': () => <RailFixture tagFilter={[1]} />,`
- `ui/src/renderer/harness/railStories.tsx:476`: `'rail/plain-selected': () => <RailFixture selected={path('acme-ui')} />,`
- `ui/src/renderer/harness/railStories.tsx:477`: `'rail/renaming': () => <RailRename workspace="acme-ui" />,`
- `ui/src/renderer/harness/railStories.tsx:478`: `'rail/renaming-expanded': () => <RailRename workspace="acme-api" />,`
- `ui/src/renderer/harness/railStories.tsx:479`: `'rail/ws-menu': () => <RailMenu target='[data-ws-idx="3"]' />,`
- `ui/src/renderer/harness/railStories.tsx:480`: `'rail/ws-menu-pinned': () => <RailMenu target='[data-ws-idx="0"]' />,`
- `ui/src/renderer/harness/railStories.tsx:481`: `'rail/grid-menu': () => <RailMenu target={GRID_ROW} />,`
- `ui/src/renderer/harness/railStories.tsx:482`: `'rail/grid-rename': () => <RailMenu target={GRID_ROW} pick="Rename" freezeCaret />,`
- `ui/src/renderer/harness/railStories.tsx:483`: `'rail/nav-menu': () => <RailMenu target='[data-testid="rail-nav-row"]' />,`
- `ui/src/renderer/harness/railStories.tsx:484`: `'rail/tag-menu': () => <RailClick target='[data-testid="tree-filter-toggle"]' tagFilter={[2]} />,`
- `ui/src/renderer/harness/railStories.tsx:485`: `'rail/tag-menu-empty': () => <RailClick target='[data-testid="tree-filter-toggle"]' />,`
- `ui/src/renderer/harness/railStories.tsx:486`: `'rail/add-menu': () => <RailClick target='button[aria-label="Add workspace"]' />,`
- `ui/src/renderer/harness/railStories.tsx:487`: `'rail/drag': () => <RailDrag />,`
- `ui/src/renderer/harness/railStories.tsx:488`: `'rail/settings': () => <RailFixture settingsOpen />,`
- `ui/src/renderer/harness/railStories.tsx:489`: `'rail/settings-nomatch': () => <RailSettingsSearch query="zzzz" />,`
- `ui/src/renderer/harness/railStories.tsx:490`: `'rail/settings-hit': () => <RailSettingsSearch query="theme" />,`
- `ui/src/renderer/harness/railStories.tsx:491`: `'rail/empty': () => <RailFixture workspaces={[]} withGrids={false} />,`
- `ui/src/renderer/harness/railStories.tsx:492`: `'rail/empty-workspace': () => <RailFixture workspaces={[ws('acme-core')]} pinned={[]} selected={path('acme-core')} withGrids={false} />,`
- `ui/src/renderer/harness/railStories.tsx:493`: `'rail/empty-filtered': () => <RailFixture tagFilter={[2]} workspaces={[ws('acme-core')]} withGrids={false} />,`
- `ui/src/renderer/harness/railStories.tsx:494`: `'rail/update-failed': () => <UpdateFailed />,`
- `ui/src/renderer/harness/railStories.tsx:495`: `'rail/update-running': () => <UpdateRunning />,`
- `ui/src/renderer/harness/railStories.tsx:496`: `'rail/resize-handle': () => <ResizeHandleStory dragging={false} />,`
- `ui/src/renderer/harness/railStories.tsx:497`: `'rail/resize-handle-drag': () => <ResizeHandleStory dragging />,`
- `ui/src/renderer/harness/stories.tsx:272`: `'browser/pane': () => <BrowserPanePage />,`
- `ui/src/renderer/harness/stories.tsx:273`: `'browser/pane-focused': () => <BrowserPaneFocused />,`
- `ui/src/renderer/harness/stories.tsx:274`: `'browser/pane-fresh': () => <BrowserPaneFresh />,`
- `ui/src/renderer/harness/stories.tsx:275`: `'browser/pane-narrow': () => <BrowserPaneNarrow />,`
- `ui/src/renderer/harness/stories.tsx:276`: `'browser/pane-insecure': () => <BrowserPaneInsecure />,`
- `ui/src/renderer/harness/stories.tsx:277`: `'browser/pane-phone': () => <BrowserPanePhone />,`
- `ui/src/renderer/harness/stories.tsx:278`: `'browser/pane-tablet': () => <BrowserPaneTablet />,`
- `ui/src/renderer/harness/stories.tsx:279`: `'browser/pane-tabs': () => <BrowserPaneTabs />,`
- `ui/src/renderer/harness/stories.tsx:280`: `'browser/pane-persist-error': () => <BrowserPanePersistError />,`
- `ui/src/renderer/harness/stories.tsx:288`: `'shell/add-pane-menu': () => <AddPanePopover right={24} y={24} hasWorkspace keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onClose={() => {}} onNewTerminal={() => {}} onSpawnAgent={() => {}} onSplitDown={() => {}} onNewGrid={() => {}} agentProfiles={null} workspaceActions={STORY_ACTIONS} />,`
- `ui/src/renderer/harness/stories.tsx:313`: `'legacy/pane-handoff': () => <LegacyPaneHandoffStory />,`
- `ui/src/renderer/harness/stories.tsx:325`: `'legacy/delegation-panel': () => <LegacyDelegationPanelStory />,`
- `ui/src/renderer/harness/stories.tsx:342`: `'orchestration/pane-handoff-selected': () => <PaneHandoffSelectedStory />,`
- `ui/src/renderer/harness/stories.tsx:344`: `'orchestration/delegation-panels': () => <DelegationPanelsStory />,`
- `ui/src/renderer/harness/stories.tsx:345`: `'ui-primitives': () => <UiPrimitivesStory />,`
- `ui/src/renderer/harness/stories.tsx:395`: `'rail/workspaces-multi': () => <RailWorkspacesMulti />,`
- `ui/src/renderer/harness/stories.tsx:418`: `'rail/grid-row-graphite-200': () => <RailGridRowStory theme="graphite" width={200} />,`
- `ui/src/renderer/harness/stories.tsx:419`: `'rail/grid-row-graphite-240': () => <RailGridRowStory theme="graphite" width={240} />,`
- `ui/src/renderer/harness/stories.tsx:420`: `'rail/grid-row-graphite-420': () => <RailGridRowStory theme="graphite" width={420} />,`
- `ui/src/renderer/harness/stories.tsx:421`: `'rail/grid-row-paper-200': () => <RailGridRowStory theme="paper" width={200} />,`
- `ui/src/renderer/harness/stories.tsx:422`: `'rail/grid-row-paper-240': () => <RailGridRowStory theme="paper" width={240} />,`
- `ui/src/renderer/harness/stories.tsx:423`: `'rail/grid-row-paper-420': () => <RailGridRowStory theme="paper" width={420} />,`
- `ui/src/renderer/harness/stories.tsx:459`: `'composer/controls-open': () => <ComposerControlsOpen />,`
- `ui/src/renderer/harness/stories.tsx:460`: `'composer/controls-overflow': () => <ComposerControlsOverflow />,`
- `ui/src/renderer/harness/stories.tsx:461`: `'composer/controls-states': () => <ComposerControlsStates />,`
- `ui/src/renderer/harness/stories.tsx:462`: `'composer/attachment-chips': () => <AttachmentChips />,`
- `ui/src/renderer/harness/stories.tsx:463`: `'composer/attachment-previews': () => <AttachmentPreviews />,`
- `ui/src/renderer/harness/stories.tsx:467`: `'shell/add-pane-profiles': () => <AddPaneProfiles />,`
- `ui/src/renderer/harness/stories.tsx:468`: `'shell/add-pane-disabled': () => <AddPaneDisabled />,`
- `ui/src/renderer/harness/stories.tsx:480`: `'notices/pane-corner': () => <NoticesPaneCorner />,`
- `ui/src/renderer/harness/stories.tsx:527`: `'panes/lifecycle': () => <PaneLifecycleStory />,`
- `ui/src/renderer/harness/stories.tsx:528`: `'panes/chrome-menu': () => <PaneMenuStory />,`
- `ui/src/renderer/harness/stories.tsx:529`: `'surface/pane-header': () => <PaneCheckoutHeaderStory />,`
- `ui/src/renderer/harness/stories.tsx:530`: `'surface/pane-header-orchestrator': () => <PaneOrchestratorHeaderStory />,`
- `ui/src/renderer/harness/stories.tsx:531`: `'panes/chrome-ended': () => <PaneEndedStory />,`
- `ui/src/renderer/harness/stories.tsx:532`: `'panes/sleeping': () => <PaneSleepingStory />,`
- `ui/src/renderer/harness/stories.tsx:533`: `'panes/recovery-deferred': () => <PaneRecoveryDeferredStory />,`
- `ui/src/renderer/harness/stories.tsx:534`: `'panes/chrome-terminal': () => <PaneTerminalStatesStory />,`
- `ui/src/renderer/harness/stories.tsx:535`: `'panes/chrome-misc': () => <PaneMiscStory />,`
- `ui/src/renderer/harness/stories.tsx:536`: `'panes/title-controls': () => <RenameTitleStory />,`
- `ui/src/renderer/harness/stories.tsx:540`: `'tasks/composer': () => <TasksComposerStory />,`
- `ui/src/renderer/harness/stories.tsx:588`: `'files/pane': () => <FilesPaneGraphite />,`

## Image path inventory

- `.github/assets/houston-grid.webp`
- `ui/resources/branding/animations/exports/gallery-overview.png`
- `ui/resources/branding/animations/exports/keyframes.png`
- `ui/resources/branding/animations/exports/pixel-idle.gif`
- `ui/resources/branding/animations/exports/pixel-needs-input.gif`
- `ui/resources/branding/animations/exports/pixel-sleep.gif`
- `ui/resources/branding/animations/exports/pixel-working.gif`
- `ui/resources/branding/animations/exports/rig-celebration.gif`
- `ui/resources/branding/animations/exports/rig-greeting.gif`
- `ui/resources/branding/animations/exports/rig-idle.gif`
- `ui/resources/branding/animations/exports/rig-needs-input.gif`
- `ui/resources/branding/animations/exports/rig-sleep.gif`
- `ui/resources/branding/animations/exports/rig-working.gif`
- `ui/resources/branding/animations/layers/arm_l.png`
- `ui/resources/branding/animations/layers/arm_r.png`
- `ui/resources/branding/animations/layers/core.png`
- `ui/resources/branding/animations/layers/eyes.png`
- `ui/resources/branding/animations/layers/head.png`
- `ui/resources/branding/animations/layers/ring_mask.png`
- `ui/resources/branding/animations/layers/torso.png`
- `ui/resources/branding/houston-icon-detail.png`
- `ui/resources/branding/houston-icon-small.png`
- `ui/resources/branding/houston-mascot.png`
- `ui/resources/branding/houston-promo-background.png`
- `ui/resources/icon-small.svg`
- `ui/resources/icon-symbolic.svg`
- `ui/resources/icon.png`
- `ui/resources/icons/hicolor/128x128.png`
- `ui/resources/icons/hicolor/16x16.png`
- `ui/resources/icons/hicolor/22x22.png`
- `ui/resources/icons/hicolor/24x24.png`
- `ui/resources/icons/hicolor/256x256.png`
- `ui/resources/icons/hicolor/32x32.png`
- `ui/resources/icons/hicolor/48x48.png`
- `ui/resources/icons/hicolor/512x512.png`
- `ui/resources/icons/hicolor/64x64.png`
- `ui/resources/mark-vector.svg`
- `ui/src/renderer/src/assets/backgrounds/graphite.webp`
- `ui/src/renderer/src/assets/backgrounds/paper.webp`
- `ui/src/renderer/src/assets/brand-mark-32.png`
- `ui/src/renderer/src/assets/brand-mark-64.png`
- `ui/src/renderer/src/assets/brand-mark-96.png`
- `ui/src/renderer/harness/banner.svg`
- `src-tauri/icons/128x128.png`
- `src-tauri/icons/128x128@2x.png`
- `src-tauri/icons/32x32.png`
- `src-tauri/icons/icon.png`
- `src-tauri/icons/tray/active-16.png`
- `src-tauri/icons/tray/active-20.png`
- `src-tauri/icons/tray/active-22.png`
- `src-tauri/icons/tray/active-24.png`
- `src-tauri/icons/tray/active-32.png`
- `src-tauri/icons/tray/active-40.png`
- `src-tauri/icons/tray/active-44.png`
- `src-tauri/icons/tray/active-48.png`
- `src-tauri/icons/tray/attention-16.png`
- `src-tauri/icons/tray/attention-20.png`
- `src-tauri/icons/tray/attention-22.png`
- `src-tauri/icons/tray/attention-24.png`
- `src-tauri/icons/tray/attention-32.png`
- `src-tauri/icons/tray/attention-40.png`
- `src-tauri/icons/tray/attention-44.png`
- `src-tauri/icons/tray/attention-48.png`
- `src-tauri/icons/tray/idle-16.png`
- `src-tauri/icons/tray/idle-20.png`
- `src-tauri/icons/tray/idle-22.png`
- `src-tauri/icons/tray/idle-24.png`
- `src-tauri/icons/tray/idle-32.png`
- `src-tauri/icons/tray/idle-40.png`
- `src-tauri/icons/tray/idle-44.png`
- `src-tauri/icons/tray/idle-48.png`

## Additional exact dimensions and retained status component

Icon role ui =13px, small=12px, label=11px (`theme.css:1531`); FilledMark default width/height14 applies only without sizing role/classes. Search h30 (`theme.css:1567`); tree toolbar h30 (`theme.css:1542`). Agent summary h24,px4,gap5,radius3,border divider,bg hover-fill; collapsed summary shows up to3 status groups as small chips, then provider glyphs, disclosure chevron. Tooltip hover delay400ms (`Tooltip.tsx:7`), glass background rgba(20,20,24,.90), blur16/saturate1.08,radius10,border primary10%,shadow `0 18px 44px -18px #000c` (`floatingSurface.css:1`). Window fallback order minimize,maximize,close (`windowButtonLayout.ts:11`); actual layout can differ.

### `ui/src/renderer/src/components/Sidebar.tsx:974`

```tsx
 974 |   | "working"
 975 |   | "needs-input"
 976 |   | "idle"
 977 |   | "unavailable"
 978 |   | "stopped";
 979 | 
 980 | function gridLifecycle(sessions: SessionInfo[]): {
 981 |   state: GridLifecycle;
 982 |   label: string;
 983 | } {
 984 |   const live = sessions.filter((session) => isLive(session.state));
 985 |   if (live.length === 0) return { state: "stopped", label: "No live panes" };
 986 | 
 987 |   const count = (status: SessionInfo["status"]): number =>
 988 |     live.filter((session) => session.status === status).length;
 989 |   const needsInput = live.filter((session) => session.status === "needs-input" || session.children_waiting > 0).length;
 990 |   const working = count("working");
 991 |   const starting = count("spawning");
 992 |   const idle = count("idle");
 993 |   const unavailable = count("unavailable") + count(null) + count(undefined);
 994 |   const state: GridLifecycle = needsInput
 995 |     ? "needs-input"
 996 |     : working
 997 |       ? "working"
 998 |       : starting
 999 |         ? "starting"
1000 |         : unavailable
1001 |           ? "unavailable"
1002 |           : "idle";
1003 |   const parts = [
1004 |     needsInput ? `${needsInput} need input` : "",
1005 |     working ? `${working} working` : "",
1006 |     starting ? `${starting} starting` : "",
1007 |     idle ? `${idle} ready` : "",
1008 |     unavailable ? `${unavailable} status unavailable` : "",
1009 |   ].filter(Boolean);
1010 |   return { state, label: parts.join(" · ") };
1011 | }
1012 | 
1013 | function GridStateDot({
1014 |   state: stateProp = "stopped",
1015 |   label: labelProp = "No live panes",
1016 |   sessionIds,
1017 | }: {
1018 |   state?: GridItem["state"];
1019 |   label?: string;
1020 |   sessionIds?: number[];
1021 | }): React.JSX.Element {
1022 |   const members = useSessionsSelector(
1023 |     (sessions) => (sessionIds ?? []).flatMap((id) => sessions.get(id) ?? []),
1024 |     (a, b) => a === b || (a !== null && b !== null && shallowArrayEqual(a, b)),
1025 |     null,
1026 |   );
1027 |   const lifecycle = members !== null && sessionIds !== undefined ? gridLifecycle(members) : null;
1028 |   const state = lifecycle?.state ?? stateProp;
1029 |   const label = lifecycle?.label ?? labelProp;
1030 |   const active = state === "starting" || state === "working";
1031 |   return <Tooltip label={label}><ActivityDot state={state} label={label} active={active} /></Tooltip>;
1032 | }
1033 | 
1034 | // A tab whose own and panes' tags carry no active tag leaves the rail. Unknown
1035 | // pane membership (paneTagIds undefined) stays: never hide what it cannot see.
```

### `ui/src/renderer/src/components/ui/ActivityDot.tsx:1`

```tsx
   1 | export type ActivityDotState = 'starting' | 'working' | 'needs-input' | 'idle' | 'unavailable' | 'stopped'
   2 | 
   3 | const COLOR: Record<ActivityDotState, string> = {
   4 |   working: 'var(--info)',
   5 |   starting: 'var(--accent)',
   6 |   'needs-input': 'var(--warning)',
   7 |   idle: 'var(--text-muted)',
   8 |   unavailable: 'transparent',
   9 |   stopped: 'var(--text-faint)'
  10 | }
  11 | 
  12 | export function ActivityDot({ state, label, active = false }: { state: ActivityDotState; label: string; active?: boolean }): React.JSX.Element {
  13 |   return <span role="img" aria-label={label} data-testid="grid-state-dot" data-state={state} className={`w-[var(--sz-grid-state-dot)] h-[var(--sz-grid-state-dot)] rounded-full flex-none ${active ? 'loop-anim [--dot-pulse-opacity:var(--opacity-grid-state-pulse)] motion-safe:animate-[dot-pulse_var(--t-grid-state-pulse)_steps(4,end)_infinite]' : ''}`} style={{ background: COLOR[state], boxShadow: state === 'unavailable' ? 'inset 0 0 0 1px var(--text-faint)' : undefined, opacity: state === 'stopped' ? 'var(--opacity-grid-state-stopped)' : undefined }} />
  14 | }
```

### `ui/src/renderer/src/components/ui/Icon.tsx:1`

```tsx
   1 | import { TIGHT_ICON_MAP, type IconComponent } from '../icons'
   2 | export type IconRole = 'display' | 'title' | 'heading' | 'subhead' | 'body' | 'ui' | 'small' | 'label'
   3 | 
   4 | const TIGHT_ROLES: ReadonlySet<IconRole> = new Set(['label', 'small', 'ui'])
   5 | 
   6 | const ICON_STRUCTURE_CLS = 'block flex-none'
   7 | 
   8 | export const ICON_ROLE_CLS: Readonly<Record<IconRole, string>> = Object.freeze({
   9 |   display:
  10 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-display-size)] [width:1em] [height:1em] ` +
  11 |     '[stroke-width:var(--tr-icon-display-stroke)]',
  12 |   title:
  13 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-title-size)] [width:1em] [height:1em] ` +
  14 |     '[stroke-width:var(--tr-icon-title-stroke)]',
  15 |   heading:
  16 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-heading-size)] [width:1em] [height:1em] ` +
  17 |     '[stroke-width:var(--tr-icon-heading-stroke)]',
  18 |   subhead:
  19 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-subhead-size)] [width:1em] [height:1em] ` +
  20 |     '[stroke-width:var(--tr-icon-subhead-stroke)]',
  21 |   body:
  22 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-body-size)] [width:1em] [height:1em] ` +
  23 |     '[stroke-width:var(--tr-icon-body-stroke)]',
  24 |   ui:
  25 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-ui-size)] [width:1em] [height:1em] ` +
  26 |     '[stroke-width:var(--tr-icon-ui-stroke)]',
  27 |   small:
  28 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-small-size)] [width:1em] [height:1em] ` +
  29 |     '[stroke-width:var(--tr-icon-small-stroke)]',
  30 |   label:
  31 |     `${ICON_STRUCTURE_CLS} [font-size:var(--tr-icon-label-size)] [width:1em] [height:1em] ` +
  32 |     '[stroke-width:var(--tr-icon-label-stroke)]'
  33 | })
  34 | 
  35 | export function resolveTightGlyph(Glyph: IconComponent, role: IconRole): IconComponent {
```

### `ui/src/renderer/src/components/ui/inspector.css:1`

```tsx
   1 | .pane-inspector{container-type:inline-size;position:relative;display:flex;flex:none;flex-direction:column;min-width:0;min-height:0;background:var(--rail-bg)}
   2 | .pane-inspector[data-state="entering"]{animation:inspector-slide-in var(--motion-panel-t) var(--motion-panel-ease) both}
   3 | .pane-inspector[data-state="closing"]{animation:inspector-slide-out var(--motion-panel-t) var(--motion-panel-ease) both}
   4 | @media (prefers-reduced-motion: reduce){.pane-inspector[data-state="entering"],.pane-inspector[data-state="closing"]{animation:none;transform:none}}
   5 | .inspector-tabs{display:flex;align-items:center;gap:var(--space-1);height:30px;min-height:30px;padding:0 var(--space-2);border-bottom:1px solid var(--divider)}
   6 | .inspector-tab{display:inline-flex;align-items:center;gap:var(--space-1);height:22px;padding:0 var(--space-2);border:0;border-radius:var(--tr-radius-sm);background:transparent;color:var(--text-secondary);font:inherit;font-size:var(--tr-text-small-size);white-space:nowrap}
   7 | .inspector-tab:hover{background:var(--hover-fill);color:var(--text-primary)}
   8 | .inspector-tab.is-selected{background:var(--card-hover);color:var(--text-primary)}
   9 | .inspector-tab-count{color:var(--text-muted);font-variant-numeric:tabular-nums}
  10 | .inspector-subject{display:flex;align-items:center;gap:var(--space-1-5);min-width:0;padding:var(--space-2-5) var(--space-3) var(--space-2);border-bottom:1px solid var(--divider);font-size:var(--tr-text-small-size)}
  11 | .inspector-subject-icon{display:inline-flex;flex:none;align-items:center;justify-content:center}
  12 | .inspector-subject-icon svg{width:14px;height:14px}
  13 | .inspector-subject strong{flex:none;min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  14 | .inspector-subject-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  15 | .pane-inspector-content{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
  16 | .pane-inspector-content>.inspector-card{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;overflow:hidden;margin:0;border:0;border-radius:0;background:transparent}
  17 | .pane-inspector-content [data-testid="source-control-panel"]{border:0;border-radius:0;background:transparent}
  18 | .pane-inspector-content .files-panel{border:0;border-radius:0;background:transparent}
  19 | .pane-inspector-content .files-panel .files-tree-column{width:100%;border:0;max-height:45%;display:flex}
  20 | .pane-inspector-content .files-panel .files-columns{flex-direction:column}
  21 | .pane-inspector-content .files-panel .editor-leaf{border-top:1px solid var(--border)}
  22 | .inspector-story-viewport{display:flex;width:100%;height:100%;min-width:0;min-height:0;background:var(--content-bg);color:var(--text-primary);font:var(--tr-text-small-size)/1.5 var(--font-sans)}
  23 | .inspector-story-grid{flex:1;min-width:0;min-height:0;background:var(--content-bg)}
  24 | .inspector-tabs{height:30px;margin:var(--space-2) var(--space-2) 0;padding:var(--space-1);gap:var(--space-1);border:1px solid var(--border);border-radius: var(--tr-radius-sm);}
  25 | .inspector-tab{height:22px;padding:0 var(--space-2);font-size:var(--tr-text-small-size)}
  26 | .inspector-tab-count{padding:0 var(--space-1);border-radius: var(--tr-radius-sm);background:var(--hover-fill);font-family:var(--font-mono);font-size:var(--tr-text-xs);}
  27 | .inspector-subject{padding:var(--space-2-5) var(--space-3) var(--space-2);gap:var(--space-1-5);font-size:var(--tr-text-small-size)}
  28 | .inspector-subject-meta{font-size:var(--tr-text-xs)}
  29 | .pane-inspector-content .changes-group-head{height:26px;padding:0 var(--space-3);font-family:var(--font-mono);font-size:var(--tr-text-xs);letter-spacing:.1em}
```

### `ui/src/renderer/src/theme.css:1000`

```tsx
1000 |   --tr-voice-meter-marker-width: 2px;
1001 |   --tr-voice-error-copy-width: 280px;
1002 |   --motion-meter-frame: 60ms;
1003 | }
1004 | 
1005 | :root,
1006 | [data-theme] {
1007 |   --material-base-bg: var(--content-bg);
1008 |   --material-shell-bg: var(--rail-bg);
1009 |   --gutter-bg: var(--rail-bg);
1010 |   --field-plate-bg: transparent;
1011 |   --material-shell-shadow: none;
1012 |   --material-inset-bg: var(--card-bg);
1013 |   --material-inset-brd: var(--border);
1014 |   --material-raised-bg: var(--raised);
1015 |   --material-raised-brd: var(--border);
1016 |   --material-raised-shadow: var(--shadow-1);
1017 |   --material-raised-glass-bg: var(--glass-bg);
1018 |   --material-raised-glass-brd: var(--glass-brd);
1019 |   --material-overlay-bg: var(--raised);
1020 |   --material-overlay-brd: var(--border);
1021 |   --material-overlay-shadow: var(--shadow-2);
1022 |   --material-overlay-glass-bg: var(--glass-bg);
1023 |   --material-overlay-glass-brd: var(--glass-brd);
1024 |   --material-base-worst: var(--content-bg);
1025 |   --material-shell-worst: var(--rail-bg);
1026 |   --material-inset-worst: var(--card-bg);
1027 |   --material-raised-worst: var(--raised);
1028 |   --material-overlay-worst: var(--raised);
1029 | }
1030 | 
1031 | [data-material='shell'] {
1032 |   --text-muted: var(--material-shell-text-muted);
1033 |   --text-faint: var(--material-shell-text-faint);
1034 |   --color-text-muted: var(--material-shell-text-muted);
1035 | }
1036 | [data-material='inset'] {
1037 |   --text-muted: var(--material-inset-text-muted);
1038 |   --text-faint: var(--material-inset-text-faint);
1039 |   --color-text-muted: var(--material-inset-text-muted);
1040 | }
1041 | [data-material='raised'] {
1042 |   --text-muted: var(--material-raised-text-muted);
1043 |   --text-faint: var(--material-raised-text-faint);
1044 |   --color-text-muted: var(--material-raised-text-muted);
1045 | }
1046 | [data-material='raised-glass'] {
1047 |   --text-muted: var(--material-raised-glass-text-muted);
1048 |   --text-faint: var(--material-raised-glass-text-faint);
1049 |   --color-text-muted: var(--material-raised-glass-text-muted);
1050 | }
1051 | [data-material='overlay'] {
1052 |   --text-muted: var(--material-overlay-text-muted);
1053 |   --text-faint: var(--material-overlay-text-faint);
1054 |   --color-text-muted: var(--material-overlay-text-muted);
1055 | }
1056 | 
```

### `ui/src/renderer/src/theme.css:1521`

```tsx
1521 |   --tr-icon-display-size: 26px;
1522 |   --tr-icon-display-stroke: 1.4;
1523 |   --tr-icon-title-size: 22px;
1524 |   --tr-icon-title-stroke: 1.8;
1525 |   --tr-icon-heading-size: 18px;
1526 |   --tr-icon-heading-stroke: 2;
1527 |   --tr-icon-subhead-size: 16px;
1528 |   --tr-icon-subhead-stroke: 2.2;
1529 |   --tr-icon-body-size: 14px;
1530 |   --tr-icon-body-stroke: 2.4;
1531 |   --tr-icon-ui-size: 13px;
1532 |   --tr-icon-ui-stroke: 2.5;
1533 |   --tr-icon-small-size: 12px;
1534 |   --tr-icon-small-stroke: 2.6;
1535 |   --tr-icon-label-size: 11px;
1536 |   --tr-icon-label-stroke: 2.8;
```
