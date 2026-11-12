import type {
  PullRequestActor,
  PullRequestMergeability,
  PullRequestState,
} from "@houston-app/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";
import { useIsPhone } from "~/mobile/usePhone";

import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestActorAvatar,
  PullRequestConflictGlyph,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

export const PULL_REQUEST_ROW_CLASS =
  "group/pr-row flex w-full items-center gap-2 rounded-md py-1 pr-1 text-left";

export const PULL_REQUEST_ROW_NUMBER_CLASS =
  "shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

export function PullRequestRowGlyph({
  state,
  isDraft,
  mergeability,
  baseBranch,
  below,
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  mergeability?: PullRequestMergeability | undefined;
  baseBranch?: string | undefined;
  below?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex w-4 shrink-0 flex-col items-center gap-0.5", className)}>
      <span className="relative inline-flex">
        <PullRequestStateGlyph state={state} isDraft={isDraft} />
        {/* Offset the wrapper to keep the badge-sized tooltip trigger anchored. */}
        <span className="absolute -right-1 -bottom-1 inline-flex">
          <PullRequestConflictGlyph
            state={state}
            isDraft={isDraft}
            {...(mergeability === undefined ? {} : { mergeability })}
            {...(baseBranch === undefined ? {} : { baseBranch })}
            className="size-3 fill-background [stroke-width:2.5]"
          />
        </span>
      </span>
      {below ? <span className="inline-flex text-2xs">{below}</span> : null}
    </span>
  );
}

export function PullRequestRowLines({
  number,
  title,
  status,
  signals,
  trailing,
  meta,
  metaClassName,
  updatedAt,
}: {
  number: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  signals?: ReactNode;
  /** The meta line's right end, before the age: the row's status in words. */
  trailing?: ReactNode;
  meta?: ReactNode;
  metaClassName?: string;
  updatedAt?: string | null | undefined;
}) {
  const phone = useIsPhone();
  const updated = updatedAt ? (
    <span className={cn("shrink-0 whitespace-nowrap tabular-nums", !trailing && "ml-auto")}>
      <RelativeTime timestamp={updatedAt} />
    </span>
  ) : null;
  return (
    <span className="min-w-0 flex-1">
      {/* A phone sets the number inline before the title, so it sits on the first line of every
          row, and moves the stat onto the meta line. */}
      <span className="flex min-w-0 items-center gap-1.5 max-phone:flex-wrap max-phone:gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5 max-phone:block max-phone:basis-full">
          <span className="order-2 flex shrink-0 max-phone:order-none">{number}</span>
          <span className="min-w-0 truncate text-sm max-phone:ml-1.5 max-phone:inline max-phone:whitespace-normal max-phone:break-words">
            {title}
          </span>
        </span>
        {signals ? (
          <span className="flex shrink-0 items-center gap-1 text-2xs max-phone:flex-wrap">
            {signals}
          </span>
        ) : null}
        {status && !phone ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs">{status}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground max-phone:min-h-5",
          metaClassName,
        )}
      >
        {meta}
        {phone && status ? (
          <span className="flex shrink-0 items-center gap-1.5">{status}</span>
        ) : null}
        {trailing ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">{trailing}</span>
        ) : null}
        {updated}
      </span>
    </span>
  );
}

export function PullRequestRowAuthor({
  actor,
  className,
  labelClassName,
}: {
  actor: PullRequestActor | null;
  className?: string;
  labelClassName?: string;
}) {
  const login = actor?.login ?? "ghost";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("inline-flex min-w-0 items-center gap-1", className)} />}
      >
        <PullRequestActorAvatar actor={actor} className="size-3.5" />
        <span className={cn("truncate", labelClassName)}>{login}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {actor?.name && actor.name !== login ? `${actor.name} (@${login})` : login}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestRowBranches({ head, base }: { head: string; base: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono">
      <MiddleTruncate value={head} />
      <span className="shrink-0">→</span>
      <MiddleTruncate value={base} className="max-w-[45%] shrink-0" />
    </span>
  );
}
