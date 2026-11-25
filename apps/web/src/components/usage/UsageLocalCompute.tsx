import type { EnvironmentId } from "@houston-app/contracts";
import type {
  InferenceUsageRow,
  InferenceUsageWindow,
} from "@houston-app/contracts/houston/inference";
import { formatPercent, formatTokens } from "@houston-app/shared/usageFormat";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import {
  INFERENCE_SERVERS_EMPTY_INPUT,
  inferenceServers,
  inferenceUsage,
} from "../../state/inference";
import {
  formatMeasuredSeconds,
  formatTokensPerSecond,
  MISSING_MEASUREMENT,
} from "../../lib/inferenceMetrics";
import { Card } from "../ui/card";
import { Text } from "../ui/text";
import { ThreadDetailsRow, ThreadDetailsRowContent } from "../ui/thread-details-row";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  INFERENCE_PURPOSE_LABELS,
  LOCAL_COMPUTE_WINDOW_LABELS,
  groupLocalCompute,
  type LocalComputeGroup,
} from "./UsageLocalCompute.logic";

function percentile(value: number | null, unit: "ms" | "rate"): string {
  if (value === null) return MISSING_MEASUREMENT;
  return unit === "ms" ? formatMeasuredSeconds(value) : formatTokensPerSecond(value);
}

function cachedShare(group: LocalComputeGroup): string {
  return group.totals.promptTokens <= 0
    ? MISSING_MEASUREMENT
    : formatPercent(Math.min(1, group.totals.cachedPromptTokens / group.totals.promptTokens), 0);
}

function GroupRow({ group }: { readonly group: LocalComputeGroup }) {
  const interactive = group.rows.find((row) => row.purpose === "interactive") ?? group.rows[0];
  const failures = group.rows.filter((row) => row.failed > 0);
  const summary = [
    `${group.totals.requests.toLocaleString("en-US")} requests`,
    `${formatTokens(group.totals.promptTokens)} prompt`,
    `${formatTokens(group.totals.completionTokens)} output`,
    `${cachedShare(group)} cached`,
    `queue p50 ${percentile(interactive?.queueWaitMs.p50 ?? null, "ms")}`,
    `p95 ${percentile(interactive?.queueWaitMs.p95 ?? null, "ms")}`,
    `TTFT p50 ${percentile(interactive?.ttftMs.p50 ?? null, "ms")}`,
    `decode p50 ${percentile(interactive?.decodeTokensPerSecond.p50 ?? null, "rate")}`,
    ...group.rows.map((row) => `${INFERENCE_PURPOSE_LABELS[row.purpose]} ${row.requests}`),
  ].join(" · ");
  return (
    <>
      <ThreadDetailsRow>
        <ThreadDetailsRowContent label={group.model} value={summary} right={group.serverName} />
      </ThreadDetailsRow>
      {failures.map((row) => (
        <ThreadDetailsRow key={`failed-${row.purpose}`}>
          <ThreadDetailsRowContent
            label="Failures"
            value={`${row.failed} ${row.failed === 1 ? "failure" : "failures"} (${INFERENCE_PURPOSE_LABELS[row.purpose]})${row.lastFailure?.advice === undefined ? "" : `: ${row.lastFailure.advice}`}`}
            right={group.serverName}
          />
        </ThreadDetailsRow>
      ))}
    </>
  );
}

function EnvironmentLocalCompute({
  environmentId,
  window,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly window: InferenceUsageWindow;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(inferenceUsage({ environmentId, input: { window } }));
  const rows: ReadonlyArray<InferenceUsageRow> = query.data?.rows ?? [];
  const groups = groupLocalCompute(rows, null);
  if (groups.length === 0) {
    return (
      <Text as="p" variant="caption" tone="muted">
        No local model requests through Houston&apos;s gateway on {label} in this window.
      </Text>
    );
  }
  return (
    <>
      <Text as="p" variant="caption" tone="muted">
        {label}
      </Text>
      {groups.map((group) => (
        <GroupRow key={group.key} group={group} />
      ))}
    </>
  );
}

/**
 * One environment's local model work, measured by Houston's gateway and never priced as cloud
 * spend. Shown only where a model server is registered, so the page stays as it was without one.
 */
function EnvironmentLocalComputeCard({
  environmentId,
  label,
  labelled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Several environments each get a card, so each names its own. */
  readonly labelled: boolean;
}) {
  const [window, setWindow] = useState<InferenceUsageWindow>("24h");
  const servers = useEnvironmentQuery(
    inferenceServers({ environmentId, input: INFERENCE_SERVERS_EMPTY_INPUT }),
  );
  if ((servers.data?.servers.length ?? 0) === 0) return null;
  const title = labelled ? `Local compute on ${label}` : "Local compute";
  return (
    <Card>
      <Text as="h2" variant="headline" weight="semibold">
        {title}
      </Text>
      <Text as="p" variant="caption" tone="muted">
        Measured by Houston&apos;s gateway; never counted as cloud spend.
      </Text>
      <ToggleGroup
        aria-label={`${title} window`}
        variant="segmented"
        value={[window]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "24h" || value === "7d") setWindow(value);
        }}
      >
        <Toggle value="24h" aria-label={`${title}, ${LOCAL_COMPUTE_WINDOW_LABELS["24h"]}`}>
          {LOCAL_COMPUTE_WINDOW_LABELS["24h"]}
        </Toggle>
        <Toggle value="7d" aria-label={`${title}, ${LOCAL_COMPUTE_WINDOW_LABELS["7d"]}`}>
          {LOCAL_COMPUTE_WINDOW_LABELS["7d"]}
        </Toggle>
      </ToggleGroup>
      <EnvironmentLocalCompute environmentId={environmentId} window={window} label={label} />
    </Card>
  );
}

export function UsageLocalCompute({
  environments,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  return environments.map((environment) => (
    <EnvironmentLocalComputeCard
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      labelled={environments.length > 1}
    />
  ));
}
