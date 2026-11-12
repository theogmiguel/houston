import { PlusIcon, XIcon } from "lucide-react";
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "../../lib/utils";
import { TooltipPopup } from "./tooltip";

/**
 * The paint of the layout's panes, tab bars, tabs, resize handles and drop zones. Feature
 * components in `layout/` place these and own no visual recipe of their own.
 */

export type LayoutBarPlacement = "pane" | "window";

/**
 * A pane's frame: its rect in the strip, the tab bar and the surface. The surface is a card on
 * the window background and the bar sits above it, so the active tab and the card read as one
 * silhouette. A `window` bar is the top pane of a column, sharing the window chrome's row.
 */
export function LayoutPaneFrame({
  focused,
  dimmed = false,
  bar,
  squareStart,
  ref,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  /** The pane holds keyboard focus; marked on the surface for behaviour and tests, not drawn. */
  focused: boolean;
  /** Several panes share the strip and another holds focus: every tab label in this pane drops one tier. */
  dimmed?: boolean;
  bar: ReactNode;
  /** The active tab is the bar's first: the surface's top-start corner meets it square. */
  squareStart: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  const surface = (
    <div
      data-layout-pane-surface=""
      data-focused={focused ? "" : undefined}
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-clip rounded-(--r-group) bg-(--pane)",
        squareStart && "rounded-ss-none",
      )}
    >
      {children}
    </div>
  );
  return (
    <div
      ref={ref}
      data-layout-pane-frame=""
      data-pane-dimmed={dimmed ? "" : undefined}
      className={cn("group/pane absolute flex flex-col", className)}
      {...props}
    >
      {bar}
      {surface}
    </div>
  );
}

/** Where the active tab's content sits: under the bar, above the frame, clear of the bar's pointer. */
export function LayoutPaneBody({
  placement,
  hidden = false,
  inert,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  placement: LayoutBarPlacement;
  /**
   * Off screen but mounted: moved out of the window (Electron keeps applying a stale window drag
   * region to anything left in it) and skipped by rendering, so its state survives at no cost.
   */
  hidden?: boolean;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute flex flex-col",
        hidden && "inset-0 -translate-x-[calc(100%+100vw)] [content-visibility:hidden]",
        className,
      )}
      data-layout-pane-body=""
      inert={hidden || inert}
      {...props}
    >
      <div aria-hidden className={placement === "window" ? "h-10 shrink-0" : "h-8 shrink-0"} />
      <div className="pointer-events-auto relative flex min-h-0 flex-1 flex-col overflow-clip rounded-b-(--r-group)">
        {children}
      </div>
    </div>
  );
}

/**
 * What a tab shows while its content is not drawn: a quiet block with a few lines where the
 * content will be, so the pane reads as present in the overview and as it comes near.
 */
export function LayoutStandIn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      data-layout-stand-in=""
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-3 bg-(--pane) p-6", className)}
      {...props}
    >
      <div className="h-3 w-2/5 rounded-full bg-foreground/5" />
      <div className="h-3 w-3/5 rounded-full bg-foreground/5" />
      <div className="h-3 w-1/2 rounded-full bg-foreground/5" />
    </div>
  );
}

/**
 * The tab bar, on the window background above its pane's card. The window bar is the window
 * chrome's 40px row; the pane bar is 32px. `leadingInset` and `trailingInset` keep tabs clear of the window controls.
 */
export function LayoutTabBar({
  placement,
  leadingInset,
  trailingInset,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  placement: LayoutBarPlacement;
  leadingInset?: string | undefined;
  trailingInset?: string | undefined;
}) {
  const style: CSSProperties = {
    ...(leadingInset ? { paddingInlineStart: leadingInset } : {}),
    ...(trailingInset ? { paddingInlineEnd: trailingInset } : {}),
  };
  return (
    <div
      data-layout-tab-bar={placement}
      style={style}
      className={cn(
        "flex shrink-0 items-end [-webkit-app-region:drag]",
        placement === "window" ? "h-10" : "h-8",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** The scrolling row of tabs: no scrollbar, a fade at the edge while tabs overflow. */
export function LayoutTabStrip({
  overflowing,
  ref,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { overflowing: boolean; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      data-layout-tab-strip=""
      data-overflowing={overflowing ? "" : undefined}
      className={cn(
        "flex min-w-0 items-stretch overflow-x-auto pe-2.5 overscroll-x-contain [-webkit-app-region:no-drag] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden data-[overflowing]:[mask-image:linear-gradient(90deg,black_calc(100%-28px),transparent)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

const CONCAVE_START = "radial-gradient(circle at 0 0, transparent 9.5px, var(--pane) 10px)";
const CONCAVE_END = "radial-gradient(circle at 100% 0, transparent 9.5px, var(--pane) 10px)";

/**
 * Holds a tab and its close button. The tab's icon hides while the slot is hovered or the
 * close button has keyboard focus, and the close button takes its place.
 */
export function LayoutTabSlot({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-layout-tab-slot=""
      className={cn("group/tab relative inline-flex max-w-48 shrink-0 items-stretch", className)}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * A tab. Active tabs are the pane surface's colour and flare into the card with concave lower
 * corners (the first tab meets the card's square corner). A ghost tab is italic until kept.
 */
export function LayoutTabShell({
  active,
  ghost,
  first,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLButtonElement> & {
  active: boolean;
  ghost: boolean;
  first: boolean;
}) {
  return (
    <button
      type="button"
      data-active={active ? "" : undefined}
      data-ghost={ghost ? "" : undefined}
      className={cn(
        "relative flex min-w-0 items-center gap-1.5 px-3 text-xs outline-none transition-colors duration-(--motion-feedback) ease-standard focus-visible:ring-2 focus-visible:ring-(--accent-ink) focus-visible:ring-inset motion-reduce:transition-none",
        "h-8 self-end",
        active
          ? "rounded-t-(--r-group) bg-(--pane) font-medium text-foreground group-data-[pane-dimmed]/pane:text-muted-foreground"
          : "rounded-(--r-ctl) text-muted-foreground hover:text-foreground group-data-[pane-dimmed]/pane:text-muted-foreground/70 group-data-[pane-dimmed]/pane:hover:text-foreground",
        ghost && "italic",
        className,
      )}
      {...props}
    >
      {children}
      {active ? (
        <>
          {first ? null : (
            <span
              aria-hidden
              data-layout-tab-corner="start"
              className="absolute -start-2.5 bottom-0 size-2.5"
              style={{ background: CONCAVE_START }}
            />
          )}
          <span
            aria-hidden
            data-layout-tab-corner="end"
            className="absolute -end-2.5 bottom-0 size-2.5"
            style={{ background: CONCAVE_END }}
          />
        </>
      ) : null}
    </button>
  );
}

/** The tab's icon, hidden while the slot shows the close button in its place. */
export function LayoutTabIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center group-hover/tab:invisible group-has-[[data-tab-close]:focus-visible]/tab:invisible">
      {children}
    </span>
  );
}

export function LayoutTabTitle({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("min-w-0 truncate pe-0.5", className)} {...props} />;
}

export type LayoutTabMarkTone = "running" | "attention" | "dirty";

const MARK_TONE: Record<LayoutTabMarkTone, string> = {
  running: "bg-(--accent)",
  attention: "bg-(--warn)",
  dirty: "bg-muted-foreground",
};

/** A small dot after the title: work running, input needed, or unsaved changes. */
export function LayoutTabMark({ tone, label }: { tone: LayoutTabMarkTone; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      data-layout-tab-mark={tone}
      className={cn("size-1.5 shrink-0 rounded-full", MARK_TONE[tone])}
    />
  );
}

/** The close button over a tab's icon: visible while the pointer is on the tab or it has focus. */
export function LayoutTabClose({
  tabId,
  label,
  onClick,
}: {
  tabId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <span className="absolute start-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center">
      <button
        type="button"
        aria-label={label}
        data-tab-close={tabId}
        onClick={onClick}
        className="flex size-4 cursor-pointer items-center justify-center rounded-(--r-badge) text-muted-foreground opacity-0 outline-none transition-opacity duration-(--motion-feedback) ease-standard hover:bg-hover group-hover/tab:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent-ink) motion-reduce:transition-none"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  );
}

/** The `+` button after the last tab. */
export function LayoutTabAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-layout-tab-add=""
      onClick={onClick}
      className="grid h-8 w-7 shrink-0 cursor-pointer place-items-center self-end rounded-(--r-ctl) text-muted-foreground outline-none transition-colors duration-(--motion-feedback) ease-standard hover:text-foreground focus-visible:ring-2 focus-visible:ring-(--accent-ink) focus-visible:ring-inset motion-reduce:transition-none [-webkit-app-region:no-drag]"
    >
      <PlusIcon aria-hidden className="size-3.5" />
    </button>
  );
}

/** The tab bar's trailing end, where the chat of the pane's active tab places its one control. */
export function LayoutTabBarActions({
  ref,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      data-layout-bar-actions=""
      className={cn(
        "ms-auto flex h-8 shrink-0 items-center self-end ps-1 [-webkit-app-region:no-drag]",
        className,
      )}
      {...props}
    />
  );
}

/** An empty pane's body: what it holds, and where a tab would go. */
export function LayoutEmptyBody({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** The strip's own empty workspace, or one drawn under the overview or mid-switch. */
export function LayoutEmptyWorkspaceFrame({
  drawn,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { drawn: boolean }) {
  return (
    <div
      data-layout-empty-frame=""
      className={cn(
        "absolute flex flex-col",
        drawn && "overflow-clip rounded-(--r-group) bg-(--pane) ring-1 ring-(--divider) ring-inset",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** A dot on the strip's edge for a pane an agent opened off screen. */
export function LayoutPeekDot({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-layout-unseen-peek={side}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-30 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent-ink)",
        side === "left" ? "left-0" : "right-0",
      )}
    >
      <span aria-hidden className="size-2 rounded-full bg-(--info)" />
    </button>
  );
}

/**
 * A resize gutter: an 8px strip on a pane boundary that drags or steps the pair beside it. Its
 * line shows on hover, keyboard focus and while dragging.
 */
export function LayoutResizeGutter({
  orientation,
  dragging,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  orientation: "vertical" | "horizontal";
  dragging: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      tabIndex={0}
      data-layout-gutter={orientation}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        "absolute z-30 touch-none select-none outline-none [-webkit-app-region:no-drag] after:absolute after:rounded-full after:bg-transparent after:transition-colors after:duration-(--motion-feedback) after:ease-standard after:content-[''] hover:after:bg-(--accent-ink) focus-visible:after:bg-(--accent-ink) data-[dragging]:after:bg-(--accent-ink) motion-reduce:after:transition-none",
        orientation === "vertical"
          ? "cursor-col-resize after:inset-y-0 after:start-[3px] after:w-0.5"
          : "cursor-row-resize after:inset-x-0 after:top-[3px] after:h-0.5",
        className,
      )}
      {...props}
    />
  );
}

/** The line on the edge a drag moves, and the pill naming the new size. */
export function LayoutResizeGuide({
  orientation,
  style,
}: {
  orientation: "vertical" | "horizontal";
  style: CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "absolute rounded-full bg-foreground",
        orientation === "vertical" ? "w-0.5 -translate-x-1/2" : "h-0.5 -translate-y-1/2",
      )}
      style={style}
    />
  );
}

export function LayoutPill({
  style,
  icon,
  children,
}: {
  style: CSSProperties;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-layout-pill=""
      className="absolute flex h-6.5 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-(--r-ctl) bg-foreground px-2.5 text-xs whitespace-nowrap text-background shadow-[var(--shadow-1)]"
      style={style}
    >
      {icon}
      {children}
    </div>
  );
}

/** The window overlay of a drag: it keeps webviews and iframes from swallowing the pointer. */
export function LayoutDragOverlay({ children }: { children: ReactNode }) {
  return (
    <div
      data-layout-drag-overlay=""
      aria-hidden
      className="fixed inset-0 z-[90] cursor-grabbing select-none"
    >
      {children}
    </div>
  );
}

/** The part of the window a drop fills. */
export function LayoutDropZoneBox({ style }: { style: CSSProperties }) {
  return (
    <div
      data-layout-drop-zone=""
      className="absolute rounded-(--r-group) bg-hover ring-1 ring-(--accent-ink) ring-inset"
      style={style}
    />
  );
}

/** A grip on a pane's side: the side a drop would split. */
export function LayoutDropGrip({
  side,
  active,
  style,
}: {
  side: "left" | "right" | "up" | "down";
  active: boolean;
  style: CSSProperties;
}) {
  return (
    <div
      data-layout-drop-grip={side}
      data-active={active ? "" : undefined}
      className={cn("absolute rounded-full", active ? "bg-foreground" : "bg-foreground/35")}
      style={style}
    />
  );
}

/** A bar outside the strip's edge: a drop there makes a new column (or workspace, below). */
export function LayoutDropExtendBar({
  edge,
  active,
  style,
}: {
  edge: "left" | "right" | "bottom";
  active: boolean;
  style: CSSProperties;
}) {
  return (
    <div
      data-layout-drop-extend={edge}
      data-active={active ? "" : undefined}
      className={cn(
        "absolute rounded-(--r-badge) ring-1 ring-inset",
        active ? "bg-foreground/35 ring-foreground/50" : "bg-foreground/12 ring-foreground/20",
      )}
      style={style}
    />
  );
}

/** The label that names where the drop lands. */
export function LayoutDropPill({ style, children }: { style: CSSProperties; children: ReactNode }) {
  return (
    <div
      data-layout-drop-pill=""
      className="absolute flex h-6.5 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-(--r-ctl) bg-foreground px-2.5 text-xs whitespace-nowrap text-background shadow-[var(--shadow-1)]"
      style={style}
    >
      {children}
    </div>
  );
}

/** The lifted, tilted tab under the pointer while a tab is dragged. */
export function LayoutDragGhost({
  style,
  children,
}: {
  style: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      data-layout-drag-ghost=""
      className="absolute top-0 left-0 flex h-8 max-w-48 items-center gap-1.5 rounded-t-(--r-group) bg-(--raised) px-3 text-xs text-foreground shadow-[var(--shadow-1)]"
      style={style}
    >
      {children}
    </div>
  );
}

export type LayoutStripMode = "fit" | "scroll" | "clip";

/**
 * The strip's viewport: it scrolls sideways when the columns are wider than the window, clips
 * while a workspace switch moves its rows, and otherwise holds still.
 */
export function LayoutStripScroller({
  mode,
  inactive,
  ref,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  mode: LayoutStripMode;
  inactive: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      data-layout-strip=""
      inert={inactive}
      className={cn(
        "relative h-full min-h-0 w-full overscroll-x-none bg-(--app-chrome-background) px-2 pb-2",
        inactive && "pointer-events-none invisible absolute inset-0",
        mode === "scroll" &&
          "overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        mode === "clip" && "overflow-clip",
        mode === "fit" && "overflow-hidden",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * The strip's stage: panes sit on it by rect, and a camera move transforms it. Under the overview
 * it leaves the strip's clip for a fixed frame the size of the strip (`--overview-frame-*`), so
 * the zoom can carry every workspace's row over the window.
 */
export function LayoutStage({
  staged = false,
  ref,
  style,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { staged?: boolean; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      data-layout-stage=""
      className={cn(
        staged
          ? "fixed top-(--overview-frame-top) left-(--overview-frame-left) z-30 h-(--overview-frame-height) w-(--overview-frame-width)"
          : "relative isolate h-full overflow-clip",
        className,
      )}
      style={{ transformOrigin: "top left", ...style }}
      {...props}
    >
      {children}
    </div>
  );
}

/** A layer over its container that paints and takes no pointer input. */
export function LayoutPassiveLayer({ children }: { children?: ReactNode }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-40">
      {children}
    </div>
  );
}

/** Keeps the strip as wide as it was while a resize drag previews a narrower one. */
export function LayoutHeldWidth({ width }: { width: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute top-0 left-0 h-px" style={{ width }} />
  );
}

/** A tab's hover label; line breaks in `children` separate its facts. */
export function LayoutTabTooltip({ children }: { children: ReactNode }) {
  return (
    <TooltipPopup side="bottom" className="whitespace-pre-line">
      {children}
    </TooltipPopup>
  );
}
