import type { OtlpSignal } from "@houston-app/contracts";
import {
  DATADOG_SITES,
  type DatadogSite,
  type HoustonObservabilityPreset,
} from "@houston-app/contracts/houston/observability";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  DATADOG_KEY_EMPTY_INPUT,
  clearDatadogKey,
  datadogKeyStatus,
  setDatadogKey,
} from "../../state/observabilityExport";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import {
  type AgentDraft,
  DATADOG_SIGNAL_DESCRIPTIONS,
  DATADOG_SITE_LABELS,
  datadogKeyProblem,
  datadogKeyStatusLabel,
  parseAgentDraft,
} from "./telemetryExport.logic";

type DatadogPreset = Extract<HoustonObservabilityPreset, { _tag: "Datadog" }>;

export interface SignalStatus {
  readonly label: string;
  readonly dot: string;
}

const SIGNALS: ReadonlyArray<{ readonly signal: OtlpSignal; readonly label: string }> = [
  { signal: "traces", label: "Traces" },
  { signal: "metrics", label: "Metrics" },
  { signal: "logs", label: "Logs" },
];

const isSite = (value: unknown): value is DatadogSite =>
  (DATADOG_SITES as ReadonlyArray<unknown>).includes(value);

const failureMessage = (cause: unknown, fallback: string) => {
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message === "" ? fallback : message;
};

function DatadogKeyField({
  environmentId,
  disabled,
}: {
  readonly environmentId: string;
  readonly disabled: boolean;
}) {
  const status = useEnvironmentQuery(
    datadogKeyStatus({ environmentId: environmentId as never, input: DATADOG_KEY_EMPTY_INPUT }),
  );
  const setKey = useAtomCommand(setDatadogKey, { reportFailure: false });
  const clearKey = useAtomCommand(clearDatadogKey, { reportFailure: false });
  const [key, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const present = status.data?.present === true;
  const problem = datadogKeyProblem(key);

  const run = async (operation: "set" | "clear") => {
    setBusy(true);
    setFailure(null);
    const input = { environmentId: environmentId as never };
    const result =
      operation === "set"
        ? await setKey({ ...input, input: { key } })
        : await clearKey({ ...input, input: DATADOG_KEY_EMPTY_INPUT });
    setBusy(false);
    if (result._tag === "Failure") {
      setFailure(failureMessage(result.cause, "The Datadog API key could not be changed."));
      return;
    }
    setKeyDraft("");
    status.refresh();
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="datadog-api-key">API key</Label>
        <Text variant="callout" tone="muted">
          {datadogKeyStatusLabel(status)}
        </Text>
      </div>
      <div className="flex gap-2">
        <Input
          id="datadog-api-key"
          size="compact"
          type="password"
          autoComplete="new-password"
          placeholder={
            present ? "Enter a new key to replace the saved one" : "32 hexadecimal characters"
          }
          value={key}
          disabled={disabled || busy}
          onChange={(event) => {
            setKeyDraft(event.target.value);
            setFailure(null);
          }}
        />
        <Button
          type="button"
          size="compact"
          variant="outline"
          disabled={disabled || busy || key.trim() === "" || problem !== null}
          onClick={() => void run("set")}
        >
          Save key
        </Button>
        {present && (
          <Button
            type="button"
            size="compact"
            variant="destructive-outline"
            disabled={disabled || busy}
            onClick={() => void run("clear")}
          >
            Remove
          </Button>
        )}
      </div>
      {status.data === null && status.error !== null && (
        <Text as="p" role="alert" variant="callout" tone="danger">
          {status.failure?.message ?? status.error}
        </Text>
      )}
      {(problem ?? failure) && (
        <Text as="p" role="alert" variant="callout" tone="danger">
          {problem ?? failure}
        </Text>
      )}
      <Text as="p" variant="callout" tone="muted">
        Stored in the server's secret store on that machine and sent only to the chosen site.
      </Text>
    </div>
  );
}

export function DatadogExportFields({
  environmentId,
  preset,
  disabled,
  statuses,
  onChange,
  onTest,
}: {
  readonly environmentId: string;
  readonly preset: DatadogPreset;
  readonly disabled: boolean;
  /** Per signal: its check status, or null when Test is unavailable. */
  readonly statuses: Record<OtlpSignal, SignalStatus | null>;
  readonly onChange: (preset: DatadogPreset) => void;
  readonly onTest: ((signal: OtlpSignal) => void) | null;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="datadog-site">Site</Label>
        <Select
          value={preset.site}
          onValueChange={(value) => {
            if (isSite(value)) onChange({ ...preset, site: value });
          }}
          disabled={disabled}
        >
          <SelectTrigger id="datadog-site" size="sm" aria-label="Datadog site">
            <SelectValue>{DATADOG_SITE_LABELS[preset.site]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {DATADOG_SITES.map((site) => (
              <SelectItem key={site} hideIndicator value={site}>
                {DATADOG_SITE_LABELS[site]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <DatadogKeyField environmentId={environmentId} disabled={disabled} />
      <div className="grid gap-2">
        {SIGNALS.map(({ signal, label }) => {
          const status = statuses[signal];
          const enabled = preset.signals[signal];
          return (
            <div key={signal} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Switch
                        size="sm"
                        checked={enabled}
                        disabled={disabled}
                        aria-label={`Send ${label.toLowerCase()} to Datadog`}
                        onCheckedChange={(checked) =>
                          onChange({ ...preset, signals: { ...preset.signals, [signal]: checked } })
                        }
                      />
                    }
                  />
                  <TooltipPopup>{DATADOG_SIGNAL_DESCRIPTIONS[signal]}</TooltipPopup>
                </Tooltip>
                <Text>{label}</Text>
              </div>
              <div className="flex items-center gap-2">
                {enabled && status && (
                  <span className="flex items-center gap-1.5">
                    <ConnectionStatusDot dotClassName={status.dot} />
                    <Text variant="callout" tone="muted">
                      {status.label}
                    </Text>
                  </span>
                )}
                {enabled && onTest && (
                  <Button
                    type="button"
                    size="compact"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => onTest(signal)}
                  >
                    Test
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DatadogAgentFields({
  draft,
  problem,
  disabled,
  onChange,
}: {
  readonly draft: AgentDraft;
  /** Why the draft cannot be saved yet, or null. */
  readonly problem: string | null;
  readonly disabled: boolean;
  readonly onChange: (draft: AgentDraft) => void;
}) {
  // The host is at fault when the draft stays invalid with any valid port.
  const hostInvalid =
    problem !== null && parseAgentDraft({ ...draft, port: "1" })._tag === "Invalid";
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="datadog-agent-host">Agent OTLP receiver</Label>
      <div className="flex gap-2">
        <Input
          id="datadog-agent-host"
          size="compact"
          aria-label="Agent host"
          aria-invalid={hostInvalid}
          value={draft.host}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, host: event.target.value })}
        />
        <Input
          size="compact"
          inputMode="numeric"
          aria-label="Agent port"
          aria-invalid={problem !== null && !hostInvalid}
          value={draft.port}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, port: event.target.value })}
        />
      </div>
      {problem !== null && (
        <Text as="p" role="alert" variant="callout" tone="danger">
          {problem}
        </Text>
      )}
      <Text as="p" variant="callout" tone="muted">
        The Agent holds the API key and needs its OTLP HTTP receiver turned on.
      </Text>
    </div>
  );
}
