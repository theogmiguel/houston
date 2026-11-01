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
      <span className="flex min-w-0 items-center gap-1.5">
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
  return <div className={cn(ROW_CLASS, "cursor-default", className)} {...props} />;
}

export function ThreadDetailsRowButton({ className, ...props }: ComponentProps<"button">) {
  return <button type="button" className={cn(ROW_CLASS, "cursor-pointer", className)} {...props} />;
}

/** A row's label column: the same recipe without its own horizontal padding. */
export function ThreadDetailsRowLabelButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button type="button" className={cn(ROW_CLASS, "cursor-pointer px-0", className)} {...props} />
  );
}
