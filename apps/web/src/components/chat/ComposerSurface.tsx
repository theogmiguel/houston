import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

function Shell({
  contextRow = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextRow?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--composer)] [--chat-composer-outline:var(--line-strong)]",
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn("relative z-10 flex w-full flex-col", className)}
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "relative z-10 w-full overflow-hidden rounded-xl border border-(--line-strong) bg-(--composer)",
        className,
      )}
      {...props}
    />
  );
}

/** The context strip behind the top of the card (environment, worktree, branch). */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative z-0 mx-2.5 -mb-2.25 flex w-[calc(100%-1.25rem)] min-w-0 items-center gap-px overflow-x-clip rounded-t-md border border-(--border) border-b-0 bg-(--pane-head) px-1.25 pt-0.75 pb-3 text-(--t3) text-xs",
        // Every strip control is one 22px tab button, labels in the secondary ink.
        "[&_[data-composer-context-control]]:h-5.5! [&_[data-composer-context-control]]:rounded-md! [&_[data-composer-context-control]]:border-0! [&_[data-composer-context-control]]:px-1.5! [&_[data-composer-context-control]]:font-medium [&_[data-composer-context-control]]:text-(--t3)! [&_[data-composer-context-control]]:text-xs!",
        "[&_[data-composer-label]]:font-medium [&_[data-composer-label]]:text-(--t2)",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
