import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
}) {
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      // A row can still render nothing (a fresh draft quiets Git actions), so an empty section
      // collapses, and a divider only follows a section that has content.
      className={cn(
        "px-1.5 py-1 has-[>div:last-child:empty]:hidden",
        separated &&
          "border-border [section:not(:has(>div:last-child:empty))~&]:mt-1 [section:not(:has(>div:last-child:empty))~&]:border-t [section:not(:has(>div:last-child:empty))~&]:pt-2",
      )}
    >
      <div
        className={cn(
          "mb-0.5 flex min-w-0 items-center justify-between gap-2 px-2 pt-0.5 pb-1",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-semibold text-muted-foreground select-none"
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
