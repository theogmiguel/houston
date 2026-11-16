import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function QuickComposerPanel({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-dvh w-full flex-col gap-3 bg-background p-3 text-foreground",
        className,
      )}
      data-slot="quick-composer-panel"
      {...props}
    >
      {children}
    </div>
  );
}

export function QuickComposerLabel({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}
      data-slot="quick-composer-label"
      {...props}
    />
  );
}

export function QuickComposerEditorFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 focus-within:border-ring",
        className,
      )}
      data-slot="quick-composer-editor"
      {...props}
    />
  );
}

export function QuickComposerImageTile({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("group relative overflow-hidden rounded-md border border-border/70", className)}
      data-slot="quick-composer-image"
      {...props}
    />
  );
}

export function QuickComposerImageThumb({ className, ...props }: React.ComponentProps<"img">) {
  return (
    <img
      className={cn("size-14 object-cover", className)}
      data-slot="quick-composer-thumb"
      {...props}
    />
  );
}

export function QuickComposerImageRemove({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/90 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function QuickComposerAlert({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-destructive", className)} role="alert" {...props} />;
}

export function QuickComposerHint({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function QuickComposerFooter({ children }: { readonly children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3">{children}</div>;
}
