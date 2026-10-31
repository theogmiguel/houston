import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";

import type { WindowButtonKind, WindowButtonLayout } from "~/lib/windowButtonLayout";
import { windowControlLabel } from "~/lib/windowButtonLayout";
import { cn } from "~/lib/utils";

function ButtonGlyph({ kind, maximized }: { kind: WindowButtonKind; maximized: boolean }) {
  if (kind === "minimize") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 5h8v1H1z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "maximize") {
    return maximized ? (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M3 1v2H1v6h6V7h2V1H3zM6 8H2V4h4v4zM8 6H7V3H4V2h4v4z" fill="currentColor" />
      </svg>
    ) : (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 1v8h8V1H1zm7 7H2V2h6v6z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2 2l6 6M8 2l-6 6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
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
          : "group-hover/wc:bg-primary/16 group-hover/wc:text-primary group-active/wc:bg-primary/24",
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
      style={{ ["-webkit-app-region" as string]: "no-drag" } as CSSProperties}
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
