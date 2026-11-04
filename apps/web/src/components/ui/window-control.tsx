import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";

import type { WindowButtonKind, WindowButtonLayout } from "~/lib/windowButtonLayout";
import { windowControlLabel } from "~/lib/windowButtonLayout";
import { cn } from "~/lib/utils";

// Stroked at 1.5px, the drawn weight of the 14px lucide icons beside them at stroke 2.5.
const GLYPH_STROKE_PX = 1.5;

function GlyphPath({ d }: { d: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={GLYPH_STROKE_PX}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ButtonGlyph({ kind, maximized }: { kind: WindowButtonKind; maximized: boolean }) {
  if (kind === "minimize") return <GlyphPath d="M2.5 6h7" />;
  if (kind === "maximize") {
    return maximized ? (
      <GlyphPath d="M2.5 4.5h5V9.5h-5V4.5zM4.5 4.5V2.5h5V7.5H7.5" />
    ) : (
      <GlyphPath d="M2.5 2.5h7v7h-7z" />
    );
  }
  return <GlyphPath d="M3 3l6 6M9 3l-6 6" />;
}

export function WindowControlButton({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "group/wc flex h-(--h-top) w-(--w-window-control) shrink-0 cursor-default items-center justify-center border-none bg-transparent p-0 outline-none [-webkit-app-region:no-drag]",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function WindowControlDisc({
  tone,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone: "close" | "regular";
}) {
  return (
    <span
      {...props}
      className={cn(
        "flex size-5 items-center justify-center rounded bg-transparent text-[color-mix(in_srgb,var(--muted-foreground)_55%,var(--foreground))] transition-[background-color,color] duration-100 group-focus-visible/wc:outline-2 group-focus-visible/wc:outline-offset-1 group-focus-visible/wc:outline-ring motion-reduce:transition-none",
        tone === "close"
          ? "group-hover/wc:bg-destructive/20 group-hover/wc:text-destructive group-active/wc:bg-destructive/30"
          : "group-hover/wc:bg-primary/16 group-hover/wc:text-(--accent-ink) group-active/wc:bg-primary/24",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function WindowControls({
  layout,
  maximized = false,
  onClose,
  onMinimize,
  onMaximize,
  className,
}: {
  layout: WindowButtonLayout;
  maximized?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  className?: string;
}) {
  if (layout.buttons.length === 0) {
    return null;
  }

  const handlers: Record<WindowButtonKind, (() => void) | undefined> = {
    close: onClose,
    minimize: onMinimize,
    maximize: onMaximize,
  };

  return (
    <div
      data-testid="window-controls"
      data-window-controls=""
      className={cn("flex h-(--h-top) items-center", className)}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      {layout.buttons.map((kind) => {
        const label = windowControlLabel(kind, maximized);
        return (
          <WindowControlButton key={kind} aria-label={label} onClick={handlers[kind]}>
            <WindowControlDisc
              aria-hidden
              data-testid="window-control-disc"
              tone={kind === "close" ? "close" : "regular"}
            >
              <ButtonGlyph kind={kind} maximized={maximized} />
            </WindowControlDisc>
          </WindowControlButton>
        );
      })}
    </div>
  );
}

export function WindowResizeGrip({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("fixed z-(--z-window-resize) [-webkit-app-region:no-drag]", className)}
      {...props}
    />
  );
}
