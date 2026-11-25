import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { threadInferenceRequest } from "../../state/inference";
import { formatLastInferenceRequest } from "../../lib/inferenceMetrics";
import { ThreadDetailsRow, ThreadDetailsRowContent } from "../ui/thread-details-row";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Measured numbers for the thread's latest request through Houston's gateway. */
export function ThreadDetailsLastRequest({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(threadInferenceRequest({ environmentId, input: { threadId } }));
  const last = query.data?.last ?? null;
  if (last === null) return null;
  const summary = formatLastInferenceRequest(last);
  const fallback =
    last.fallbackFrom === undefined ? null : ` · fell back from ${last.fallbackFrom}`;
  return (
    <ThreadDetailsSection
      headingId="thread-details-last-request-heading"
      title="Last request"
      showHeading={false}
    >
      <ThreadDetailsRow>
        <ThreadDetailsRowContent
          label="Last request"
          value={`${summary}${fallback ?? ""}`}
          right={`${last.model} on ${last.serverId}`}
        />
      </ThreadDetailsRow>
    </ThreadDetailsSection>
  );
}
