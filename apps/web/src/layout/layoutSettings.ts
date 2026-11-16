/** Device-local pane defaults and behavior (Settings › Layout); the server stores workspaces, not these. */

/** What a layout pane shows. Each opened thing is a tab in a pane of one of these kinds. */
export type LayoutPaneKind = "chat" | "terminal" | "diff" | "files" | "browser";

/** One pane of the template; `span: "full"` runs the last pane of the first column under every column. */
export interface LayoutTemplatePane {
  readonly kind: LayoutPaneKind;
  readonly size: number;
  readonly span: "column" | "full";
}

export interface LayoutTemplateColumn {
  readonly size: number;
  readonly panes: readonly LayoutTemplatePane[];
}

/** The panes a chat and its companions open into. */
export interface LayoutTemplate {
  readonly columns: readonly LayoutTemplateColumn[];
}

export const DEFAULT_LAYOUT_TEMPLATE: LayoutTemplate = {
  columns: [
    {
      size: 1,
      panes: [
        { kind: "chat", size: 0.64, span: "column" },
        { kind: "terminal", size: 0.36, span: "column" },
      ],
    },
  ],
};

export type LayoutTerminalPlacement = "attached-below" | "new-tab" | "new-column";
export type LayoutSidePanePlacement = "beside-chat" | "new-tab" | "new-column";
export type LayoutSidePaneOpensOn = "last-used" | "diff" | "files" | "browser" | "pull-request";
export type LayoutNewTabPosition = "after-current" | "end";
export type LayoutWhenNoRoom = "shrink-then-scroll" | "always-shrink" | "always-scroll";

export interface LayoutSettings {
  readonly template: LayoutTemplate;
  readonly terminalPlacement: LayoutTerminalPlacement;
  readonly sidePanePlacement: LayoutSidePanePlacement;
  readonly sidePaneOpensOn: LayoutSidePaneOpensOn;
  readonly newTabPosition: LayoutNewTabPosition;
  readonly whenNoRoom: LayoutWhenNoRoom;
}

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  template: DEFAULT_LAYOUT_TEMPLATE,
  terminalPlacement: "attached-below",
  sidePanePlacement: "beside-chat",
  sidePaneOpensOn: "last-used",
  newTabPosition: "after-current",
  whenNoRoom: "shrink-then-scroll",
};
