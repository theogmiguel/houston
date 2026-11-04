import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Fades a stack of ghost rows out toward the title. */
const PAGE_EMPTY_GHOST_OPACITY = ["opacity-70", "opacity-45", "opacity-25"];

/**
 * What a panel surface shows when it has nothing to render: a small glyph, one title, a line
 * of explanation and at most one way forward. Empty, unavailable and failed flow states share
 * it so they read like a page's empty state instead of as loose captions.
 */
export function PanelEmptyState({
  icon,
  title,
  description,
  action,
  tone = "default",
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 py-8 text-center">
      <span
        aria-hidden
        className={cn(
          "mb-2 inline-flex [&_svg]:size-4",
          tone === "error" ? "text-error-foreground" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <p className="text-headline font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-72 text-body text-muted-foreground wrap-anywhere">{description}</p>
      ) : null}
      {action ? <div className="mt-3 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * A page-level empty state accepts an icon, faded ghost rows, or a custom ghost. Use fill to
 * center the content in the remaining scroll area when the page has no centered container.
 */
export function PageEmptyState({
  fill = false,
  align = "center",
  icon,
  ghostRows = 0,
  ghost,
  title,
  description,
  children,
}: {
  fill?: boolean;
  align?: "center" | "start";
  icon?: ReactNode;
  ghostRows?: number;
  ghost?: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-150 flex-col items-center gap-7 pt-8 text-center",
        fill && "flex-1 justify-center pb-16",
        align === "start" && "max-w-105 items-start text-left",
      )}
    >
      {ghost !== undefined ? (
        <div aria-hidden className="w-full max-w-105">
          {ghost}
        </div>
      ) : ghostRows > 0 ? (
        <div aria-hidden className="flex w-full max-w-105 flex-col gap-2">
          {Array.from({ length: ghostRows }, (_, index) => (
            <div
              key={index}
              className={cn(
                "flex items-center gap-3 rounded-[var(--r-group)] border border-border bg-card px-3.5 py-3",
                PAGE_EMPTY_GHOST_OPACITY[index] ?? "opacity-40",
              )}
            >
              <span className="size-4 shrink-0 rounded-[var(--r-badge)] bg-(--surface-raised)" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="h-1.5 w-3/5 rounded-full bg-(--surface-raised)" />
                <span className="h-1.5 w-1/4 rounded-full bg-(--surface-raised)" />
              </span>
              <span className="h-5.5 w-16 shrink-0 rounded-[var(--r-ctl)] bg-(--surface-raised)" />
            </div>
          ))}
        </div>
      ) : icon !== undefined ? (
        <span
          aria-hidden
          className="inline-flex size-12 items-center justify-center rounded-[var(--r-group)] bg-(--surface-raised) text-foreground [&_svg:not([class*='size-'])]:size-4.5"
        >
          {icon}
        </span>
      ) : null}
      <div className="flex max-w-120 flex-col gap-1.5">
        <h2 className="text-headline font-medium text-foreground">{title}</h2>
        <p className="text-body text-balance text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** A row of equal hint tiles under an empty state, optionally under a small heading. */
export function PageEmptyTiles({
  title,
  narrow = false,
  children,
}: {
  title?: string;
  /** Match the narrow text column instead of the full empty state. */
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-2 text-left", narrow && "max-w-105")}>
      {title ? (
        <h3 className="flex min-h-7 items-center text-callout font-medium text-muted-foreground">
          {title}
        </h3>
      ) : null}
      <div className="grid gap-3 sm:auto-cols-fr sm:grid-flow-col">{children}</div>
    </div>
  );
}

/** `aside` sits at the tile's top right; children pin to its bottom. */
export function PageEmptyTile({
  icon,
  title,
  description,
  aside,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--r-group)] border border-transparent bg-card p-3">
      {aside ? (
        <span className="mb-1 flex items-center justify-between gap-2 text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
          {icon}
          {aside}
        </span>
      ) : null}
      <span className="flex items-center gap-2 text-body text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        {aside ? null : icon}
        {title}
      </span>
      <span className="text-callout text-muted-foreground">{description}</span>
      {children ? <div className="mt-auto">{children}</div> : null}
    </div>
  );
}
