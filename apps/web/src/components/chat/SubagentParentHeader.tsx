import { ArrowUpRightIcon, UsersIcon } from "lucide-react";

import { Button } from "../ui/button";

export function SubagentParentHeader(props: {
  readonly title: string;
  readonly environmentLabel?: string | undefined;
  readonly onOpen?: (() => void) | undefined;
}) {
  return (
    <div className="flex h-[34px] min-w-0 items-center gap-2 border-b border-border bg-code px-3 text-xs text-muted-foreground">
      <UsersIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Subagent of <span className="font-semibold text-foreground">{props.title}</span>
        {props.environmentLabel ? ` on ${props.environmentLabel}` : null}
      </span>
      <span className="flex-1" />
      {props.onOpen === undefined ? null : (
        <Button size="sm" variant="ghost" onClick={props.onOpen}>
          <ArrowUpRightIcon />
          Open parent
        </Button>
      )}
    </div>
  );
}
