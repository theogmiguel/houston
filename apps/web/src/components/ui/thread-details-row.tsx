import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

const ROW_CLASS =
  "grid min-h-7 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-0.5 text-left text-body font-normal text-foreground outline-none transition-[background-color] hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-[var(--hover)] disabled:pointer-events-none disabled:opacity-64";

/** The label and its inline value share one left edge; the right slot holds chevrons, status or chips. */
export function ThreadDetailsRowContent({
  label,
  value,
  mono = false,
  right,
}: {
  readonly label: ReactNode;
  readonly value?: ReactNode;
  readonly mono?: boolean;
  readonly right?: ReactNode;
}) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate">{label}</span>
        {value === undefined || value === null ? null : (
          <span className={cn("min-w-0 truncate text-muted-foreground", mono && "font-mono")}>
            {value}
          </span>
        )}
      </span>
      {right === undefined || right === null ? (
        <span aria-hidden />
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {right}
        </span>
      )}
    </>
  );
}

export function ThreadDetailsRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-thread-details-row=""
      className={cn(ROW_CLASS, "cursor-default", className)}
      {...props}
    />
  );
}

export function ThreadDetailsRowButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-thread-details-row=""
      className={cn(ROW_CLASS, "cursor-pointer", className)}
      {...props}
    />
  );
}

/** A mono value, such as a worktree or branch name, inside a row's right slot. */
export function ThreadDetailsRowMono({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <span className={cn("min-w-0 truncate font-mono", className)}>{children}</span>;
}

/**
 * A row's label column. It fills the row's content box without adding vertical
 * padding of its own, which would make the row taller than the shared 28px.
 */
export function ThreadDetailsRowLabelButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 cursor-pointer items-center self-stretch truncate rounded-md text-left text-body font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64",
        className,
      )}
      {...props}
    />
  );
}
