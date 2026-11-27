import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function StartTruncatedPath({
  path,
  detail,
  className,
}: {
  path: string;
  detail?: string | undefined;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left",
              className,
            )}
            dir="rtl"
          />
        }
      >
        <bdi>{path}</bdi>
      </TooltipTrigger>
      <TooltipPopup side="top" variant="code">
        {path}
        {detail === undefined ? null : <span>{detail}</span>}
      </TooltipPopup>
    </Tooltip>
  );
}
