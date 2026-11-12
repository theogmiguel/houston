import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The paint of the new-tab launcher: a narrow column of grouped rows. Feature components in
 * `layout/` place these and own no visual recipe of their own.
 */

/** Fills a pane and centres the launcher list, scrolling when the pane is short. */
export function LayoutLauncherFrame({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto scrollbar-gutter-both px-4",
        className,
      )}
      {...props}
    />
  );
}

export function LayoutLauncherList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="list"
      className={cn("flex w-full max-w-110 flex-col gap-0.5 py-6 text-left", className)}
      {...props}
    />
  );
}

export function LayoutLauncherGroup({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" className="px-2 pt-3 pb-1 text-caption text-muted-foreground">
      {children}
    </div>
  );
}

export function LayoutLauncherRow({
  icon,
  label,
  detail,
  disabledReason,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  detail?: string | undefined;
  /** Says why the row cannot be used; the row stays visible and does nothing. */
  disabledReason?: string | undefined;
  onSelect: () => void;
}) {
  const disabled = disabledReason !== undefined;
  return (
    <button
      type="button"
      role="listitem"
      data-layout-launcher-row=""
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-(--r-ctl) px-2 py-1.5 text-left text-body outline-none transition-colors duration-(--motion-feedback) ease-standard hover:bg-hover focus-visible:ring-2 focus-visible:ring-(--accent-ink) focus-visible:ring-inset motion-reduce:transition-none",
        disabled ? "cursor-default text-muted-foreground opacity-60" : "cursor-pointer",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {(disabledReason ?? detail) ? (
        <span className="min-w-0 max-w-1/2 truncate text-caption text-muted-foreground">
          {disabledReason ?? detail}
        </span>
      ) : null}
    </button>
  );
}
