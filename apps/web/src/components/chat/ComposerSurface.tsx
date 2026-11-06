import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { SURFACE_LIFT_CLASS } from "~/components/ui/surface-recipes";

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
        SURFACE_LIFT_CLASS,
        // On the new-thread page the composer is the page's one surface, so it rises a step.
        "[[data-draft-hero]_&]:bg-(--surface-raised) [[data-draft-hero]_&]:shadow-(--shadow-1)",
        // Under the changed-files bar the two read as one stack: the card drops its top edge.
        "[[data-changed-files-bar]+[data-slot=composer-shell]:not(.hidden)_&]:rounded-t-none [[data-changed-files-bar]+[data-slot=composer-shell]:not(.hidden)_&]:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

/** The context row under the card (project, environment, worktree, branch, permissions). */
function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative z-0 mt-1 flex w-full min-w-0 items-center gap-px overflow-x-clip px-1 text-(--contrast-secondary-label) text-xs",
        // Every strip control is a borderless 22px, 12px sans text button in the muted label ink.
        "[&_[data-composer-context-control]]:h-5.5! [&_[data-composer-context-control]]:rounded-md! [&_[data-composer-context-control]]:border-0! [&_[data-composer-context-control]]:px-1.5! [&_[data-composer-context-control]]:font-normal [&_[data-composer-context-control]]:text-secondary-label! [&_[data-composer-context-control]]:text-xs!",
        "[&_[data-composer-label]]:font-normal [&_[data-composer-label]]:text-secondary-label",
        // Branch names inside a label render mono elsewhere; the strip keeps one sans face.
        "[&_[data-composer-label]_*]:font-sans",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
