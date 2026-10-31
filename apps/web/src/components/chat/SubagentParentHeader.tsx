import { ArrowUpRightIcon, UsersIcon } from "lucide-react";

import { Button } from "../ui/button";

export function SubagentParentHeader(props: {
  readonly title: string;
  readonly environmentLabel?: string | undefined;
  readonly onOpen?: (() => void) | undefined;
}) {
  return (
    <div className="flex h-[34px] min-w-0 items-center gap-2 border-b border-border bg-(--pane-head) ps-3 pe-1.5 text-xs text-(--t2)">
      <UsersIcon aria-hidden className="size-3.25 shrink-0 text-(--t3)" />
      <span className="min-w-0 truncate">
        Subagent of <b className="font-semibold text-(--t1)">{props.title}</b>
        {props.environmentLabel ? ` on ${props.environmentLabel}` : null}
      </span>
      <span className="flex-1" />
      {props.onOpen === undefined ? null : (
        <Button size="xs" variant="ghost" onClick={props.onOpen}>
          <ArrowUpRightIcon className="size-3.25" />
          Open parent
        </Button>
      )}
    </div>
  );
}
