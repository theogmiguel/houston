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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import {
  DATADOG_SIGNAL_DESCRIPTIONS,
  DATADOG_SITE_LABELS,
  datadogKeyProblem,
} from "./telemetryExport.logic";

type DatadogPreset = Extract<HoustonObservabilityPreset, { _tag: "Datadog" }>;
type AgentPreset = Extract<HoustonObservabilityPreset, { _tag: "DatadogAgent" }>;

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
        <span className="text-xs text-muted-foreground">
          {status.data === null ? "" : present ? "Saved" : "Not set"}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          id="datadog-api-key"
          size="compact"
          type="password"
          autoComplete="off"
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
      {(problem ?? failure) && (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem ?? failure}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Stored in the server's secret store on that machine and sent only to the chosen site.
      </p>
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
                <span className="text-sm">{label}</span>
              </div>
              <div className="flex items-center gap-2">
                {enabled && status && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ConnectionStatusDot dotClassName={status.dot} />
                    {status.label}
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
  preset,
  disabled,
  onChange,
}: {
  readonly preset: AgentPreset;
  readonly disabled: boolean;
  readonly onChange: (preset: AgentPreset) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="datadog-agent-host">Agent OTLP receiver</Label>
      <div className="flex gap-2">
        <Input
          id="datadog-agent-host"
          size="compact"
          aria-label="Agent host"
          value={preset.host}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...preset, host: event.target.value.trim() || "127.0.0.1" })
          }
        />
        <Input
          size="compact"
          type="number"
          min={1}
          max={65535}
          aria-label="Agent port"
          value={String(preset.port)}
          disabled={disabled}
          onChange={(event) => {
            const port = Number(event.target.value);
            if (Number.isInteger(port) && port >= 1 && port <= 65_535)
              onChange({ ...preset, port });
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        The Agent holds the API key and needs its OTLP HTTP receiver turned on.
      </p>
    </div>
  );
}
