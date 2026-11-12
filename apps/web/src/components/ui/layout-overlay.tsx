import { ArrowLeftRightIcon, CheckIcon, PlusIcon } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  CSSProperties,
  ElementType,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
} from "react";

import { cn } from "../../lib/utils";
import { Text } from "./text";

/**
 * The paint of the layout's overlays: hints, the workspace switcher, the tour, the overview and
 * the shortcut sheet. Feature components in `layout/` place these with layout utilities and
 * own no visual recipe of their own.
 */

/** The one-shot hint pill. It fades out once `leaving`, and never takes the pointer. */
export function LayoutHintShell({
  leaving,
  small = false,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { leaving: boolean; small?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute bottom-12 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2.5 rounded-(--r-ctl) px-3 dropdown-glass transition-opacity duration-(--motion-overlay-out) ease-exit motion-reduce:transition-none",
        small ? "h-7" : "h-8",
        leaving && "opacity-0",
        className,
      )}
      {...props}
    />
  );
}

/** A hint's one line of text. */
export function LayoutHintLabel({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("min-w-0 truncate text-callout text-foreground", className)} {...props} />
  );
}

/**
 * One mark of a hint's position glyph. A `bar` is a workspace in the stack and a `cell` a column
 * in the strip; `narrow` marks the edge entry that tells the glyph scrolls on, and `small`
 * belongs to the compact pill.
 */
export function LayoutHintMark({
  shape,
  active,
  narrow = false,
  small = false,
}: {
  shape: "bar" | "cell";
  active: boolean;
  narrow?: boolean;
  small?: boolean;
}) {
  const width =
    shape === "cell"
      ? active
        ? "w-2.5"
        : "w-2"
      : small
        ? narrow
          ? "w-1"
          : "w-2"
        : narrow
          ? "w-1.5"
          : "w-2.5";
  return (
    <span
      className={cn(
        "rounded-xs",
        shape === "cell" ? "h-2.5" : "h-1",
        width,
        active ? "bg-foreground" : "bg-foreground/20",
      )}
    />
  );
}

/** Quiet secondary text: a count, a summary. */
export function LayoutMetaText({
  tabular = false,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tabular?: boolean }) {
  return <Text variant="caption" tone="muted" tabular={tabular} {...props} />;
}

/** A row of a list in a popover: hover and keyboard focus inside it wash the row. */
export function LayoutListRow({ className, ...props }: HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      className={cn(
        "group/row flex min-h-(--h-row) items-center gap-1 rounded-(--r-ctl) px-1 hover:bg-hover focus-within:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

/** The main button of a `LayoutListRow`. */
export function LayoutListRowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-(--r-ctl) px-1 py-1 text-left text-body outline-none focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

/** The check that marks the current row; hidden, not removed, so the labels stay aligned. */
export function LayoutListRowCheck({ shown }: { shown: boolean }) {
  return <CheckIcon aria-hidden className={cn("size-3.5 shrink-0", !shown && "opacity-0")} />;
}

/** A row's actions: they appear on hover or focus, and stay visible on a coarse pointer. */
export function LayoutListRowActions({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center opacity-0 transition-opacity duration-(--motion-feedback) ease-standard group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** An inline refusal under a list, read out as an alert. */
export function LayoutErrorText({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      role="alert"
      className={cn("px-2 py-1 text-caption text-(--stop-ink)", className)}
      {...props}
    />
  );
}

/** The part of a popover under a hairline, such as its create row. */
export function LayoutPopoverFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t border-(--divider) pt-1", className)} {...props} />;
}

/** The field a tour lesson's diagram is drawn on. */
export function LayoutDiagramStage({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative flex h-32 items-stretch gap-1.5 overflow-hidden rounded-(--r-ctl) bg-(--field) p-3",
        className,
      )}
      {...props}
    />
  );
}

/** A pane in a diagram: a bordered card holding a tab row and lines of text. */
export function LayoutDiagramPane({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-3 overflow-hidden rounded-(--r-ctl) border border-(--divider) bg-(--pane) p-2",
        className,
      )}
      {...props}
    />
  );
}

/** A column of panes in a diagram, wider than a lone pane beside it. */
export function LayoutDiagramColumn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-w-0 flex-[1.5] flex-col gap-1.5", className)} {...props} />;
}

/** A tab in a diagram's tab row. */
export function LayoutDiagramTab({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "flex h-5 items-center gap-1 rounded-(--r-badge) bg-hover px-1.5 text-caption text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A pane in a diagram's overview grid. */
export function LayoutDiagramCell({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center rounded-(--r-badge) border border-(--divider) bg-(--pane) px-2",
        className,
      )}
      {...props}
    />
  );
}

/** A stand-in for a line of text. */
export function LayoutDiagramLine({
  tone = "strong",
  size = "wide",
}: {
  tone?: "strong" | "faint";
  size?: "wide" | "half";
}) {
  return (
    <div
      className={cn(
        "h-1 shrink-0 rounded-full",
        size === "wide" ? "w-2/3" : "w-1/2",
        tone === "strong" ? "bg-foreground/15" : "bg-foreground/10",
      )}
    />
  );
}

/** The arrow between two panes that swap places. */
export function LayoutDiagramSwap() {
  return (
    <ArrowLeftRightIcon className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
  );
}

/** A heading in a tour step, lesson or sheet; `as="span"` where a heading would not belong. */
export function LayoutHeadline({
  as = "h2",
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "h2" | "span" }) {
  return <Text as={as} variant="headline" {...props} />;
}

/** Explanatory text under a `LayoutHeadline`. */
export function LayoutBodyText(props: HTMLAttributes<HTMLParagraphElement>) {
  return <Text as="p" variant="body" tone="muted" {...props} />;
}

/** A glyph in the quiet text colour; the caller sizes it. */
export function LayoutMutedIcon({
  icon: Icon,
  className,
}: {
  icon: ElementType<{ className?: string }>;
  className?: string;
}) {
  return <Icon aria-hidden className={cn("text-muted-foreground", className)} />;
}

/** A section's small heading in a settings page. */
export function LayoutSectionTitle(props: HTMLAttributes<HTMLHeadingElement>) {
  return <Text as="h2" variant="caption" tone="muted" {...props} />;
}

/**
 * The overview's footer: a quiet line over the window chrome that fades in and never takes the
 * pointer. The caller sets the zoom transition's timing through `style`.
 */
export function LayoutOverviewFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-40 flex h-(--h-top) items-center justify-center bg-(--app-chrome-background) text-caption text-muted-foreground motion-safe:transition-opacity motion-safe:duration-(--motion-overlay-in) motion-safe:ease-standard motion-safe:starting:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The window chrome behind the zoomed-out stage. The caller sets the zoom's transition length and
 * `closing` while the zoom back in runs.
 */
export function LayoutOverviewBackdrop({
  closing,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { closing: boolean }) {
  return (
    <div
      aria-hidden
      data-chrome-scope=""
      className={cn(
        "fixed inset-0 z-30 bg-(--app-chrome-background) motion-safe:transition-opacity motion-safe:starting:opacity-0",
        closing && "opacity-0",
        className,
      )}
      {...props}
    />
  );
}

/** The first-use tips: a quiet block under a hairline. */
export function LayoutTipsPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-t border-(--divider) pt-4 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** One tip, in the panel's quiet colour. */
export function LayoutTip({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 text-body", className)} {...props} />;
}

/** The dim layer behind the hold menu. It never takes the pointer, so the work stays live. */
export function LayoutHoldBackdrop({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-110 flex items-center justify-center bg-black/50 p-2",
        className,
      )}
      {...props}
    />
  );
}

/** The hold menu's glass panel. */
export function LayoutHoldPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex max-h-[calc(100dvh-1rem)] w-170 max-w-full flex-col gap-4 overflow-y-auto rounded-(--r-group) p-5 dialog-glass",
        className,
      )}
      {...props}
    />
  );
}

/** A one-pixel rule between the sheet's blocks. */
export function LayoutHairline({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("h-px bg-(--divider)", className)} {...props} />;
}

/** The overview's layer over the zoomed stage; it takes the pointer only once the map is open. */
export function LayoutOverviewRoot({
  open,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { open: boolean }) {
  return (
    <div className={cn("absolute inset-0", !open && "pointer-events-none", className)} {...props} />
  );
}

/** A pane in the overview: a target to pick or drag, dimmed while it is the one being dragged. */
export function LayoutOverviewPane({
  dragging,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { dragging: boolean }) {
  return (
    <div
      className={cn(
        "absolute cursor-pointer rounded-(--r-group)",
        dragging && "bg-background/60",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The ring around the focused pane or empty row. The caller sets its inset and `borderWidth` in
 * screen pixels, since the stage is scaled.
 */
export function LayoutOverviewFocusRing({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute rounded-(--r-group) border-foreground/70",
        className,
      )}
      {...props}
    />
  );
}

/** The dashed outline of a workspace with no panes. The caller sets `borderWidth`. */
export function LayoutOverviewEmptyRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 rounded-(--r-group) border-dashed border-border",
        className,
      )}
      {...props}
    />
  );
}

/** The bar that shows where a dragged pane would open a column. */
export function LayoutOverviewInsertBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 -translate-x-1/2 rounded-full bg-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The line that shows where a dragged pane would open a workspace, with its "New workspace"
 * pill. It is drawn at screen size: the caller places it on the stage and undoes the zoom.
 */
export function LayoutOverviewNewWorkspace({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex items-center justify-center",
        className,
      )}
      {...props}
    >
      <div className="h-1 w-4/5 max-w-175 rounded-full bg-foreground" />
      <div className="absolute flex h-6.5 items-center gap-1.5 rounded-(--r-ctl) bg-foreground px-2.5 text-caption text-background shadow-(--shadow-1)">
        <PlusIcon aria-hidden className="size-3.25" />
        New workspace
      </div>
    </div>
  );
}

/** What follows the pointer while a pane is dragged in the overview. */
export function LayoutOverviewDragChip({
  ref,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none fixed top-0 left-0 z-50 flex h-7 max-w-60 -rotate-2 items-center gap-1.5 rounded-(--r-ctl) bg-(--raised) px-2.5 text-caption text-foreground shadow-(--shadow-1) [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export type LayoutPaneSkeletonShape = "chat" | "terminal" | "diff" | "lines";

const SKELETON_LINE = "h-1 rounded-full bg-foreground/14";

/** Placeholder lines shaped like what a pane holds; the editor never renders live content. */
export function LayoutPaneSkeleton({ shape }: { shape: LayoutPaneSkeletonShape }) {
  if (shape === "chat") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5 pt-2">
        <div className="ms-auto h-4 w-1/2 rounded-(--r-badge) bg-foreground/8" />
        <div className={cn(SKELETON_LINE, "mt-2 w-3/5")} />
        <div className={cn(SKELETON_LINE, "w-1/2")} />
        <div className="mt-auto flex h-5 items-center justify-end rounded-(--r-ctl) border border-foreground/8 bg-foreground/4 pe-1">
          <div className="size-2 rounded-full bg-foreground/60" />
        </div>
      </div>
    );
  }
  if (shape === "terminal") {
    return (
      <div className="flex flex-col gap-1.5 p-2.5 pt-2">
        <div className={cn(SKELETON_LINE, "w-1/2")} />
        <div className="h-1 w-1/3 rounded-full bg-(--ok)/55" />
        <div className={cn(SKELETON_LINE, "w-2/5")} />
      </div>
    );
  }
  if (shape === "diff") {
    return (
      <div className="flex flex-col gap-1.5 p-2 pt-1.5">
        <div className={cn(SKELETON_LINE, "w-1/2")} />
        <div className={cn(SKELETON_LINE, "w-3/5")} />
        <div className="mt-1 h-1.5 rounded-xs bg-(--add-bg)" />
        <div className="h-1.5 rounded-xs bg-(--del-bg)" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 p-2 pt-1.5">
      <div className={cn(SKELETON_LINE, "w-1/2")} />
      <div className={cn(SKELETON_LINE, "w-3/5")} />
      <div className={cn(SKELETON_LINE, "w-2/5")} />
    </div>
  );
}

/** The canvas the template's panes are drawn on. The caller sets its padding. */
export function LayoutEditorCanvas({
  ref,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative h-65 overflow-hidden rounded-(--r-group) border border-border bg-(--app-chrome-background) select-none",
        className,
      )}
      {...props}
    />
  );
}

/** A mini pane drawn on the canvas. The caller places it with `style`. */
export function LayoutEditorPane({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-(--r-ctl) bg-(--pane)",
        className,
      )}
      {...props}
    />
  );
}

/** A mini pane's label in its notch tab, and its size chip. */
export function LayoutEditorPaneTab({
  icon: Icon,
  label,
  badge,
}: {
  icon: ElementType<{ className?: string }>;
  label: string;
  badge: string | null;
}) {
  return (
    <span className="flex h-5 min-w-0 shrink-0 items-start">
      <span className="relative flex h-5 min-w-0 items-center gap-1.25 rounded-br-sm bg-(--app-chrome-background) px-1.75 text-caption text-foreground">
        <Icon aria-hidden className="size-2.75 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </span>
      {badge !== null ? (
        <span className="ms-auto mt-0.5 me-0.5 shrink-0 rounded-(--r-badge) bg-foreground/8 px-1.5 text-3xs leading-4.5 text-muted-foreground tabular-nums">
          {badge}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A bare button for the editor's drag chips, pane panels and popover actions; their looks are
 * local to the canvas.
 */
export function LayoutEditorButton({
  variant,
  destructive = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: "drag-chip" | "panel" | "action";
  destructive?: boolean;
}) {
  return (
    <button
      {...props}
      className={cn(
        "outline-none focus-visible:outline-2 focus-visible:outline-ring",
        variant === "drag-chip" &&
          "flex h-6 cursor-grab items-center gap-1.5 rounded-(--r-ctl) border border-border bg-(--field) px-2 text-callout text-foreground touch-none",
        variant === "panel" && "cursor-pointer rounded-(--r-badge) bg-(--pane) text-left",
        variant === "action" &&
          "flex h-(--h-row) w-full items-center gap-2 rounded-(--r-ctl) px-2 text-left text-body hover:bg-hover",
        variant === "action" && destructive && "text-destructive-foreground",
        className,
      )}
    />
  );
}

/** A glyph in a popover action: quiet, or in the destructive ink. */
export function LayoutActionIcon({
  icon: Icon,
  destructive = false,
}: {
  icon: ElementType<{ className?: string }>;
  destructive?: boolean;
}) {
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5",
        destructive ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    />
  );
}

/** The layer a dragged chip's ghost rides on, above the dialogs. */
export function LayoutEditorGhostLayer({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none fixed z-140 -rotate-2", className)}
      {...props}
    />
  );
}

/** The chip as it follows the pointer. */
export function LayoutEditorChipGhost({
  icon: Icon,
  children,
}: {
  icon: ElementType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <div className="flex h-6.5 items-center gap-1.5 rounded-(--r-ctl) dropdown-glass px-2.25 text-callout text-foreground shadow-(--shadow-1)">
      <Icon aria-hidden className="size-3 text-muted-foreground" />
      {children}
    </div>
  );
}

/**
 * A label pill in the editor. `floating` lifts it onto the canvas, where the caller places it
 * with `style`; otherwise it sits in the flow of what it labels.
 */
export function LayoutEditorPill({
  icon: Icon,
  floating = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  icon?: ElementType<{ className?: string }>;
  floating?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-(--r-ctl) bg-foreground px-2 text-callout whitespace-nowrap text-background shadow-(--shadow-1)",
        floating && "pointer-events-none absolute z-10",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden className="size-3" /> : null}
      {children}
    </span>
  );
}

/** The share readout while a divider drags. The caller places it with `style`. */
export function LayoutEditorReadout({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-20 flex h-6.5 -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-(--r-ctl) bg-foreground px-2.5 text-callout text-background tabular-nums shadow-(--shadow-1)",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A divider's hit strip with the handle drawn in it. The caller places the strip with `style`
 * and handles the pointer and keys.
 */
export function LayoutEditorDivider({
  horizontal,
  active,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { horizontal: boolean; active: boolean }) {
  return (
    <div
      role="separator"
      tabIndex={0}
      className={cn(
        "group absolute z-10 flex items-center justify-center outline-none focus-visible:outline-2 focus-visible:outline-ring",
        horizontal ? "cursor-row-resize" : "cursor-col-resize",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "rounded-full group-hover:bg-foreground/60 group-focus-visible:bg-foreground/60",
          horizontal ? "h-1 w-7" : "h-7 w-1",
          active ? "bg-foreground/80" : "bg-foreground/25",
        )}
      />
    </div>
  );
}

/** The range input that sets a pane's share. */
export function LayoutEditorSlider({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <input type="range" className={cn("settings-slider min-w-0 flex-1", className)} {...props} />
  );
}

/** The percentage beside the share slider; its width keeps the slider from moving as it changes. */
export function LayoutEditorSliderValue({ children }: { children: ReactNode }) {
  return (
    <Text variant="callout" tabular className="w-9 text-end">
      {children}
    </Text>
  );
}

/** The layer that holds a drag's drop feedback over the canvas. */
export function LayoutEditorDropLayer({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 z-20", className)}
      {...props}
    />
  );
}

/** A grip on a pane's side: the side a drop would split, bright while targeted. */
export function LayoutEditorGrip({
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
      className={cn(
        "absolute rounded-full",
        side === "left" || side === "right" ? "-translate-y-1/2" : "-translate-x-1/2",
        active ? "bg-foreground" : "bg-foreground/25",
      )}
      style={style}
    />
  );
}

/** A bar on an edge of the canvas where a drop adds a column or a row. */
export function LayoutEditorEdgeBar({
  edge,
  active,
}: {
  edge: "left" | "right" | "bottom";
  active: boolean;
}) {
  return (
    <div
      className={cn(
        "absolute rounded-full",
        edge === "left" && "inset-y-0 -left-1.5 w-0.75",
        edge === "right" && "inset-y-0 -right-1.5 w-0.75",
        edge === "bottom" && "inset-x-0 -bottom-1.5 h-0.75",
        active ? "bg-foreground" : "bg-foreground/25",
      )}
    />
  );
}

/** The zone a dropped pane would take, outlined, with its label at the foot. */
export function LayoutEditorDropZone({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "absolute flex items-end justify-center rounded-(--r-ctl) border border-foreground/80 bg-foreground/6 pb-2",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled block of a pane popover. */
export function LayoutPopoverSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 p-1.5">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      {children}
    </div>
  );
}
