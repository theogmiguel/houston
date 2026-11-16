/* oxlint-disable eslint/no-restricted-imports -- This is the single styled adapter around Pierre's raw viewer. */
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewProps,
  type ControlledCodeViewProps,
  type UncontrolledCodeViewProps,
} from "@pierre/diffs/react";
/* oxlint-enable eslint/no-restricted-imports */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { Ref } from "react";

import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/lib/diffRendering";
import { relabelDiffSeparators } from "~/lib/diffSeparatorLabels";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { addOldLineNumbers } from "./unifiedGutterNumbers";

export const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
/* A 1fr track's automatic minimum grows with the currently mounted lines. In split
   wrap mode that shifts width between columns, rewraps rows and makes the virtualizer
   repeatedly correct the scroll position. Keep both code columns at the same width. */
[data-diff-type="split"][data-overflow="wrap"] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}

/* Unified rows carry two numbers, old then new (see unifiedGutterNumbers). The old one reads as
   secondary and keeps its own track so both columns stay aligned across rows. */
[data-old-line-number] {
  display: inline-block;
  min-width: var(--diffs-min-number-column-width, var(--diffs-min-number-column-width-default, 3ch));
  margin-inline-end: 1ch;
  position: relative;
  z-index: 1;
  text-align: right;
  opacity: 0.7;
}

/* Without wrapping, a long line runs past the panel edge. The library paints the horizontal
   scrollbar thumb transparent until the pointer is over the file, so nothing says the line
   continues. Keep a track and a thumb visible at rest, stronger on hover. The scrollbar height is
   the library's measured gutter and feeds the virtualizer, so only its colours change. */
[data-overflow="scroll"] [data-code]::-webkit-scrollbar-track {
  background-color: color-mix(in srgb, var(--code-foreground) 8%, transparent);
}

[data-overflow="scroll"] [data-code]::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--code-foreground) 45%, transparent) !important;
}

[data-overflow="scroll"] [data-code]::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in srgb, var(--code-foreground) 65%, transparent) !important;
}

/* The scrollbar sits under the file, often out of view, so every line also gets a fade and an
   edge shadow at the right edge of the visible column. The sticky gutter always sits at the left
   edge of the scroll viewport, so a pseudo-element anchored to it by container width lands on the
   right edge wherever the file is scrolled. The scroll-state query shows it only while there is
   more to the right. It is state, not an animation, so it also holds where animations are
   finished or disabled. Without scroll-state support the fade is simply absent. */
[data-overflow="scroll"] [data-code] {
  container-type: inline-size scroll-state;
}

[data-overflow="scroll"] [data-code] [data-gutter]::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  /* About eight code glyphs: narrower, the fade reads as a clipped glyph rather than a fade. */
  left: calc(100cqi - 64px);
  width: 64px;
  pointer-events: none;
  /* The fade alone reads as a line that ends there. A hard 2px rule plus a 14px shadow on top
     mark a scroll edge that is visible at rest, whatever token the line is cut inside. */
  background:
    linear-gradient(to left, color-mix(in srgb, var(--code-foreground) 55%, transparent) 2px, transparent 2px),
    linear-gradient(to left, color-mix(in srgb, var(--code-foreground) 40%, transparent), transparent 14px),
    linear-gradient(to right, transparent, var(--code-background) 85%);
  opacity: 0;
}

/* On a phone the viewer sits in an inset container, so the scroll cue is a light shadow
   instead of a hard rule. */
@media (max-width: 40rem) {
  /* The expand row shares the code's edges instead of sitting 8px inside them. */
  [data-separator-wrapper] {
    padding-inline: 0 !important;
  }

  [data-overflow="scroll"] [data-code] [data-gutter]::after {
    left: calc(100cqi - 20px);
    width: 20px;
    background: linear-gradient(to left, color-mix(in srgb, var(--code-foreground) 16%, transparent), transparent);
  }
}

@container scroll-state(scrollable: right) {
  [data-overflow="scroll"] [data-code] [data-gutter]::after {
    opacity: 1;
  }
}

:is(
  [data-line],
  [data-line-annotation],
  [data-merge-conflict],
  [data-merge-conflict-actions],
  [data-no-newline]
)[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 88%,
      color-mix(in srgb, var(--code-background) 50%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 80%,
      color-mix(in srgb, var(--code-background) 70%, var(--diffs-modified-base))
    )
  ) !important;
}

:is([data-gutter-buffer], [data-column-number])[data-selected-line] {
  --diffs-line-bg: light-dark(
    color-mix(
      in lab,
      var(--code-background) 91%,
      color-mix(in srgb, var(--code-background) 35%, var(--diffs-modified-base))
    ),
    color-mix(
      in lab,
      var(--code-background) 85%,
      color-mix(in srgb, var(--code-background) 60%, var(--diffs-modified-base))
    )
  ) !important;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line] {
  position: relative;
}

[data-indicators="bars"]
  :is([data-column-number], [data-gutter-buffer="annotation"])[data-selected-line]::before {
  position: absolute !important;
  inset-block: 0 !important;
  inset-inline-start: 0 !important;
  display: block !important;
  width: 4px !important;
  min-width: 4px !important;
  max-width: 4px !important;
  height: auto !important;
  padding: 0 !important;
  content: "" !important;
  background-color: var(--diffs-modified-base) !important;
  background-image: none !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  align-items: center !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  /* Collapsed items are never remeasured: the painted header must match diffHeaderHeight.
     Center controls in that height instead of adding padding to their intrinsic height. */
  height: 32px !important;
  min-height: 32px !important;
  padding-block: 0 !important;
  padding-inline: 8px 12px !important;
}

[data-diffs-header]:hover {
  /* A native scrollbar gutter cannot be painted by descendants. Use an inset edge cue instead
     of a full-width band that would look accidentally clipped at the gutter. */
  background-color: var(--code-background) !important;
  box-shadow: inset 3px 0 color-mix(in srgb, var(--code-foreground) 24%, transparent);
}

/* Hunk separators are the way to the unchanged lines between hunks. They keep the library's
   layout, with the expand button in its own cell, but sit one step off the code surface so they
   read as quiet controls; hover brings them forward. */
:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  /* Exact and margin-free: the virtualizer places rows from hunkSeparatorHeight below. */
  height: 24px !important;
  margin-block: 0 !important;
  --diffs-bg-separator: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  color: color-mix(in srgb, var(--code-foreground) 50%, var(--code-background)) !important;
  font-family: var(--font-sans) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-expand-button] {
  color: color-mix(in srgb, var(--code-foreground) 50%, var(--code-background)) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  :is([data-separator-content], [data-expand-button]):hover {
  color: var(--code-foreground) !important;
  background-color: color-mix(
    in srgb,
    var(--code-background) 92%,
    var(--code-foreground)
  ) !important;
}

[data-diffs-header] [data-header-content] {
  align-items: center !important;
  line-height: 1 !important;
}

/* Pierre clips file names with overflow: hidden for its start ellipsis. A 1em line box cuts off
   descenders; give the clipped names room inside the fixed-height header. */
[data-diffs-header] :is([data-title], [data-prev-name]) {
  line-height: 16px !important;
}

[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition: color 120ms ease;
  font-family: var(--font-sans) !important;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--code-foreground) 84%, var(--primary)) !important;
}

/* Expanding a file mounts its body all at once; easing it in matches the 200ms the app's
   collapsibles take. Appearance only: the viewer owns geometry, so height cannot animate.
   Departing content cuts, the same one-way rule the pull request chrome fold follows. */
[data-diff],
[data-file] {
  transition: opacity 200ms ease-out;
}

@starting-style {
  [data-diff],
  [data-file] {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}

/* The Appearance "Animations" switch; this sheet lives in a shadow root. */
:host-context([data-motion="off"]) [data-diff],
:host-context([data-motion="off"]) [data-file] {
  transition: none;
}
`;

export type StyledDiffCodeViewOptions<LAnnotation> = Omit<
  NonNullable<CodeViewProps<LAnnotation, undefined>["options"]>,
  "unsafeCSS" | "itemMetrics" | "layout"
>;

type StyledDiffCodeViewProps<LAnnotation> = (
  | Omit<ControlledCodeViewProps<LAnnotation, undefined>, "options">
  | Omit<UncontrolledCodeViewProps<LAnnotation, undefined>, "options">
) & {
  readonly options?: StyledDiffCodeViewOptions<LAnnotation>;
  readonly viewerRef?: Ref<CodeViewHandle<LAnnotation, undefined>>;
  readonly unsafeCSSExtra?: string;
  /** The host hides the viewer's file headers, so none of them reserves its 32px. */
  readonly hiddenFileHeaders?: boolean;
};

export function StyledDiffCodeView<LAnnotation = undefined>({
  options,
  viewerRef,
  className,
  unsafeCSSExtra,
  hiddenFileHeaders = false,
  ...props
}: StyledDiffCodeViewProps<LAnnotation>) {
  return (
    <DiffWorkerPoolProvider>
      <CodeView<LAnnotation>
        {...props}
        {...(viewerRef ? { ref: viewerRef } : {})}
        className={
          className
            ? `diff-render-surface [--code-background:var(--background)] outline-none ${className}`
            : "diff-render-surface [--code-background:var(--background)] outline-none"
        }
        options={{
          ...options,
          onPostRender: ((container: HTMLElement, ...rest: unknown[]) => {
            // rest is (instance, phase, item context); the callback is overloaded per item type.
            if (rest[1] !== "unmount") {
              relabelDiffSeparators(container);
              const fileDiff = (
                rest[0] as { getInputDiff?: () => FileDiffMetadata | undefined } | undefined
              )?.getInputDiff?.();
              if (fileDiff) addOldLineNumbers(container, fileDiff);
            }
            return (options?.onPostRender as ((...args: unknown[]) => unknown) | undefined)?.(
              container,
              ...rest,
            );
          }) as unknown as NonNullable<StyledDiffCodeViewOptions<LAnnotation>["onPostRender"]>,
          unsafeCSS: unsafeCSSExtra
            ? `${DIFF_VIEW_UNSAFE_CSS}\n${unsafeCSSExtra}`
            : DIFF_VIEW_UNSAFE_CSS,
          itemMetrics: {
            diffHeaderHeight: hiddenFileHeaders ? 0 : 32,
            hunkSeparatorHeight: 24,
            // Zero both spacing and paddingTop; Pierre's expanded-file fallback otherwise adds an 8px header
            // gap.
            spacing: 0,
            paddingTop: 0,
            // Include Pierre's 8px --diffs-gap-fallback in metrics or each expanded file loses a scrollable
            // row.
            paddingBottom: 8,
          },
          layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
        }}
      />
    </DiffWorkerPoolProvider>
  );
}
