import { CircleHelpIcon } from "lucide-react";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * The list API does not carry CI state for every host; say so instead of leaving the row
 * silently blank, so an absent glyph is not read as "no checks".
 */
export function PullRequestChecksUnknown({ provider }: { readonly provider: string }) {
  const providerName = getSourceControlPresentationForKind(provider).providerName;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`Checks unknown: ${providerName} does not report CI status in the list`}
            className="inline-flex size-4 items-center justify-center text-muted-foreground/60"
          />
        }
      >
        <CircleHelpIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-64">
        {providerName} does not report CI status in the list. Open the pull request to read its
        checks.
      </TooltipPopup>
    </Tooltip>
  );
}
