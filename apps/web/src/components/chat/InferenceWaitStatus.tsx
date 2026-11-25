import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { INFERENCE_SERVERS_EMPTY_INPUT, inferenceServers } from "../../state/inference";
import { formatThreadInferenceWait, threadInferenceWait } from "../../lib/inferenceActivity";
import { Text } from "../ui/text";

/** "Waiting for rtx · 2 ahead" while Houston's gateway holds this thread's request. */
export function InferenceWaitStatus({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    inferenceServers({ environmentId, input: INFERENCE_SERVERS_EMPTY_INPUT }),
  );
  const wait = threadInferenceWait(query.data?.servers ?? null, threadId);
  if (wait === null) return null;
  return (
    <Text as="span" role="status" variant="caption" tone="muted">
      {formatThreadInferenceWait(wait)}
    </Text>
  );
}
