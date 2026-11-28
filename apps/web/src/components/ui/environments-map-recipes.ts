/** Visual recipes for the environments map, its details and the link dialogs. Feature code composes these with layout utilities. */
export const MAP_TOOLBAR_CLS = "rounded-t-xl border-b border-border/60 bg-background/50";
export const MAP_CAPTION_CLS = "text-2xs text-muted-foreground";
export const MAP_SELECTION_COUNT_CLS = "text-2xs text-foreground";
export const MAP_TABULAR_CLS = "tabular-nums";
export const MAP_HELP_LIST_CLS = "list-disc text-xs text-muted-foreground";
export const MAP_CANVAS_CLS =
  "cursor-grab touch-none bg-background/50 select-none data-dragging:cursor-grabbing";
export const MAP_SCENE_LAYER_CLS =
  "origin-top-left in-data-dragging:will-change-transform in-data-glide:transition-transform in-data-glide:duration-(--motion-disclosure) in-data-glide:ease-standard";
export const MAP_MARQUEE_CLS =
  "pointer-events-none rounded-sm border border-primary bg-primary/10 forced-colors:border-2";
export const MAP_CONTROLS_BAR_CLS = "bg-background/50";
export const MAP_ZOOM_GROUP_CLS = "rounded-lg border border-border/60 bg-popover/90 shadow-xs/5";
export const MAP_NOTICE_BAR_CLS = "border-b border-border/60 bg-background/50 text-xs";
export const MAP_MUTED_CLS = "text-muted-foreground";
export const MAP_COLUMN_TITLE_CLS = "text-2xs font-medium whitespace-nowrap text-muted-foreground";
export const MAP_FOREGROUND_CLS = "text-foreground";

/** Lines and halos that never take the pointer. */
export const MAP_PASSIVE_CLS = "pointer-events-none";
export const MAP_ACCENT_INK_CLS = "text-(--accent-ink)";

/** The invisible wide stroke that makes a line easy to hit. */
export const MAP_CLICKABLE_CLS = "cursor-pointer";

/** The dashed line that follows the pointer while a link is dragged. */
export const MAP_DRAG_LINE_CLS = "pointer-events-none text-(--accent-ink)";
export const MAP_ROUTE_PILL_CLS =
  "rounded-full border bg-background text-2xs leading-none text-muted-foreground";

/** A link's access name, drawn over its line. */
export const MAP_LINK_NAME_CLS =
  "cursor-pointer rounded-full border border-border bg-card text-2xs leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:border-primary aria-pressed:text-(--accent-ink)";
export const MAP_RAISED_CLS = "shadow-sm/5";
export const MAP_DIMMED_METER_CLS = "opacity-45";
export const MAP_STACK_CARD_CLS =
  "rounded-lg border border-border bg-card transition-opacity duration-(--motion-list-in) ease-standard";
export const MAP_DASHED_CLS = "border-dashed";

/** A closed stack's card, kept in place while its tray shows. */
export const MAP_HIDDEN_CLS = "opacity-0";
export const MAP_STACK_TRAY_CLS = "rounded-xl border border-border/70 bg-foreground/3";
export const MAP_STACK_FACE_CLS = "rounded-lg border bg-card hover:border-foreground/50";
export const MAP_STACK_PARTIAL_BORDER_CLS = "border-warning/60";
export const MAP_STACK_BORDER_CLS = "border-foreground/25";
export const MAP_SELECTED_RING_CLS = "ring-2 ring-primary ring-inset forced-colors:outline-2";
export const MAP_STACK_TITLE_CLS = "text-xs leading-4 font-semibold text-foreground";
export const MAP_STACK_COUNT_BADGE_CLS =
  "rounded-full bg-muted text-2xs leading-4 text-muted-foreground tabular-nums forced-colors:border";
export const MAP_STACK_CAPTION_CLS = "text-2xs leading-4 text-muted-foreground";
export const MAP_METER_INK_CLS = "text-foreground/70";
export const MAP_STACK_COUNT_CLS = "whitespace-nowrap tabular-nums";

/** The warning band under a stack whose machines are only partly reachable. */
export const MAP_STACK_PARTIAL_BAND_CLS =
  "border-t border-warning/30 bg-warning/16 text-2xs leading-none font-semibold text-warning-foreground forced-colors:border-t-2";
export const MAP_WARNING_CLS = "text-warning";
export const MAP_REACH_TRACK_CLS = "rounded-full bg-warning/25 forced-colors:hidden";
export const MAP_REACH_FILL_CLS = "rounded-full bg-warning";
export const MAP_STACK_TOGGLE_CLS =
  "cursor-pointer rounded-md text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The "and N more" chip after the machines a stack shows. */
export const MAP_MORE_CHIP_CLS =
  "cursor-pointer rounded-md border border-dashed border-foreground/30 text-2xs leading-none text-muted-foreground outline-none hover:border-foreground/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
export const MAP_CLIENT_NODE_CLS =
  "rounded-full border border-foreground/25 bg-card text-foreground hover:border-foreground/50";
export const MAP_CLIENT_LABEL_CLS = "text-xs font-semibold";
export const MAP_TARGET_NODE_CLS =
  "border bg-card text-foreground/90 hover:border-foreground/50 hover:text-foreground";
export const MAP_TARGET_COMPACT_CLS = "rounded-md";
export const MAP_TARGET_FULL_CLS = "rounded-lg";
export const MAP_TARGET_IDLE_BORDER_CLS = "border-border";
export const MAP_TARGET_COMPACT_LABEL_CLS = "text-2xs leading-none";
export const MAP_TARGET_LABEL_CLS = "text-xs leading-4 font-medium";
export const MAP_NODE_CAPTION_CLS = "text-2xs leading-4";
export const MAP_FOLDED_NODE_CLS =
  "rounded-md border border-dashed border-foreground/25 bg-card text-foreground/90 hover:border-foreground/50 hover:text-foreground";
export const MAP_DOT_CLS = "rounded-full";
export const MAP_DOT_OFF_CLS = "bg-muted-foreground/40";
export const MAP_ENVIRONMENT_NODE_CLS =
  "rounded-lg border bg-card text-card-foreground shadow-sm/5 hover:border-foreground/45";
export const MAP_ENVIRONMENT_DIMMED_BORDER_CLS = "border-dashed border-foreground/25";
export const MAP_ENVIRONMENT_BORDER_CLS = "border-foreground/20";
export const MAP_DROP_TARGET_BORDER_CLS = "border-primary";
export const MAP_MACHINE_TILE_CLS = "rounded-md bg-muted text-foreground/80 forced-colors:border";

/** A machine tile that is switched off or unsupported. */
export const MAP_DIMMED_TILE_CLS = "opacity-60";
export const MAP_STATUS_DOT_CLS = "-right-1 -bottom-1 rounded-full border-2 border-card";
export const MAP_DIMMED_TEXT_CLS = "opacity-70";
export const MAP_ENVIRONMENT_LABEL_CLS =
  "line-clamp-2 text-xs leading-4 font-semibold [overflow-wrap:anywhere]";
export const MAP_ERROR_CLS = "text-destructive";
export const MAP_LINK_HANDLE_CLS =
  "cursor-crosshair touch-none rounded-full bg-primary text-primary-foreground outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-inset transition-transform duration-(--motion-feedback) ease-standard forced-colors:border";
export const MAP_HANDLE_PLUS_CLS = "stroke-[2.5]";

/** The frame around a machine ticked for linking several at once. */
export const MAP_TICKED_FRAME_CLS =
  "pointer-events-none rounded-xl border-2 border-primary bg-primary/6";
export const MAP_TICK_BADGE_CLS =
  "-top-2 -left-2 rounded-full bg-primary text-primary-foreground forced-colors:border";
export const MAP_TICK_GLYPH_CLS = "stroke-3";
export const MAP_DRAG_HINT_CLS =
  "pointer-events-none rounded-md border border-border bg-popover text-2xs whitespace-nowrap text-popover-foreground shadow-sm/5";
export const DETAILS_UNREACHABLE_GLYPH_CLS = "rounded-full border border-muted-foreground";
export const DETAILS_REACHABLE_GLYPH_CLS = "rounded-full bg-success forced-colors:border-4";
export const DETAILS_PANEL_CLS =
  "border-t border-border/60 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
export const DETAILS_HEADING_CLS = "text-sm font-medium text-foreground";
export const DETAILS_LINK_ROW_CLS =
  "cursor-pointer grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] rounded-md text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:grid-cols-[auto_minmax(0,10rem)_minmax(0,10rem)_minmax(0,1fr)_auto]";
export const DETAILS_SECONDARY_CLS = "text-foreground/80";
export const STRONG_LABEL_CLS = "font-medium text-foreground";
export const DETAILS_ADDRESS_CLS = "font-mono text-2xs text-muted-foreground";
export const DETAILS_BLEED_CLS = "-mx-1.5";
export const DETAILS_MEMBER_LIST_CLS = "overscroll-contain";
export const DETAILS_MEMBER_ROW_CLS =
  "cursor-pointer grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] rounded-md text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:grid-cols-[minmax(0,12rem)_minmax(0,10rem)_minmax(0,1fr)_auto]";
export const DETAILS_DIVIDED_SECTION_CLS = "border-t border-border/60";
export const DETAILS_LINK_TITLE_CLS = "text-sm";
export const DETAILS_FIELDS_CLS = "grid-cols-[auto_1fr]";
export const DETAILS_FIELD_VALUE_CLS = "font-mono text-2xs break-all text-foreground";
export const DETAILS_ENDPOINT_CLS =
  "cursor-pointer rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
export const LINK_DIALOG_LEAD_CLS = "text-sm text-muted-foreground";
export const LINK_DIALOG_LABEL_CLS = "text-xs font-medium text-foreground";
export const LINK_HINT_CLS = "text-xs text-muted-foreground";
export const LINK_DIALOG_LIST_CLS = "divide-y rounded-lg border";
export const LINK_OPTION_CLS = "cursor-pointer text-sm has-data-disabled:cursor-default";
export const LINK_DIALOG_NAME_CLS = "font-medium";
export const LINK_DIALOG_ERROR_CLS = "text-xs text-destructive";
