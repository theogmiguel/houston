import type { EnvironmentId } from "@houston-app/contracts";
import type {
  InferenceUsageRow,
  InferenceUsageWindow,
} from "@houston-app/contracts/houston/inference";
import { formatPercent, formatTokens } from "@houston-app/shared/usageFormat";
import { useCallback, useEffect, useState } from "react";

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

/** Reports whether an environment has any model server registered; renders nothing. */
function ServerPresence({
  environmentId,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly onChange: (environmentId: EnvironmentId, registered: boolean) => void;
}) {
  const query = useEnvironmentQuery(
    inferenceServers({ environmentId, input: INFERENCE_SERVERS_EMPTY_INPUT }),
  );
  const registered = (query.data?.servers.length ?? 0) > 0;
  useEffect(() => onChange(environmentId, registered), [environmentId, onChange, registered]);
  return null;
}

/**
 * Local model work measured by Houston's gateway: never priced as cloud spend. Shown only for
 * environments with a registered model server, so the page stays as it was without one.
 */
export function UsageLocalCompute({
  environments,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}) {
  const [window, setWindow] = useState<InferenceUsageWindow>("24h");
  const [registered, setRegistered] = useState<ReadonlySet<EnvironmentId>>(() => new Set());
  const onPresence = useCallback((environmentId: EnvironmentId, present: boolean) => {
    setRegistered((current) => {
      if (current.has(environmentId) === present) return current;
      const next = new Set(current);
      if (present) next.add(environmentId);
      else next.delete(environmentId);
      return next;
    });
  }, []);
  const shown = environments.filter((environment) => registered.has(environment.environmentId));
  const probes = environments.map((environment) => (
    <ServerPresence
      key={environment.environmentId}
      environmentId={environment.environmentId}
      onChange={onPresence}
    />
  ));
  if (shown.length === 0) return <>{probes}</>;
  return (
    <Card>
      {probes}
      <Text as="h2" variant="headline" weight="semibold">
        Local compute
      </Text>
      <Text as="p" variant="caption" tone="muted">
        Measured by Houston&apos;s gateway; never counted as cloud spend.
      </Text>
      <ToggleGroup
        aria-label="Local compute window"
        variant="segmented"
        value={[window]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "24h" || value === "7d") setWindow(value);
        }}
      >
        <Toggle value="24h" aria-label={`Local compute, ${LOCAL_COMPUTE_WINDOW_LABELS["24h"]}`}>
          {LOCAL_COMPUTE_WINDOW_LABELS["24h"]}
        </Toggle>
        <Toggle value="7d" aria-label={`Local compute, ${LOCAL_COMPUTE_WINDOW_LABELS["7d"]}`}>
          {LOCAL_COMPUTE_WINDOW_LABELS["7d"]}
        </Toggle>
      </ToggleGroup>
      {shown.map((environment) => (
        <EnvironmentLocalCompute
          key={environment.environmentId}
          environmentId={environment.environmentId}
          window={window}
          label={environment.label}
        />
      ))}
    </Card>
  );
}
