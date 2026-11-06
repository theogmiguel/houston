import { useAtomValue } from "@effect/atom-react";
import type {
  OtlpEndpointCheckResult,
  OtlpSignal,
  ServerObservability,
} from "@houston-app/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { DatadogAgentFields, DatadogExportFields } from "./DatadogExportFields";
import {
  type AgentDraft,
  DESTINATION_LABELS,
  type TelemetryDestination,
  agentDraftOf,
  datadogIntakeUrl,
  destinationOf,
  initialPreset,
  observabilityPatch,
  parseAgentDraft,
  rejectedLabel,
} from "./telemetryExport.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

const SIGNALS = [
  {
    key: "otlpTracesUrl",
    sourceKey: "otlpTracesSource",
    variableKey: "otlpTracesVariable",
    label: "Traces",
    signal: "traces",
  },
  {
    key: "otlpMetricsUrl",
    sourceKey: "otlpMetricsSource",
    variableKey: "otlpMetricsVariable",
    label: "Metrics",
    signal: "metrics",
  },
  {
    key: "otlpLogsUrl",
    sourceKey: "otlpLogsSource",
    variableKey: "otlpLogsVariable",
    label: "Logs",
    signal: "logs",
  },
] as const;

type SignalDescriptor = (typeof SIGNALS)[number];
type SignalKey = SignalDescriptor["key"];

const OVERRIDE_LABELS = { environment: "Set by environment", bootstrap: "Set by desktop" } as const;

function runningOverride(
  running: ServerObservability | undefined,
  { key, sourceKey, variableKey }: SignalDescriptor,
) {
  const url = running?.[key];
  const source = running?.[sourceKey];
  if (url === undefined || (source !== "environment" && source !== "bootstrap")) return undefined;
  return { url, label: OVERRIDE_LABELS[source], variable: running?.[variableKey] };
}

type EndpointCheck = { readonly url: string; readonly result: OtlpEndpointCheckResult | null };

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

const DESTINATIONS: ReadonlyArray<TelemetryDestination> = [
  "off",
  "otlp",
  "datadog",
  "datadog-agent",
];
const isDestination = (value: unknown): value is TelemetryDestination =>
  (DESTINATIONS as ReadonlyArray<unknown>).includes(value);

function endpointStatus(
  url: string,
  check: EndpointCheck | undefined,
  destination: TelemetryDestination = "otlp",
) {
  if (url === "") return { label: "Off", dot: "bg-muted-foreground/40" };
  if (check?.url !== url) return { label: "Not checked", dot: "bg-muted-foreground/40" };
  const { result } = check;
  if (result === null) return { label: "Checking…", dot: "bg-warning" };
  switch (result._tag) {
    case "Accepted":
      return { label: `Connected · ${Math.round(result.latencyMs)} ms`, dot: "bg-success" };
    case "Rejected":
      return { label: rejectedLabel(result.status, destination), dot: "bg-destructive" };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", dot: "bg-destructive" };
  }
}

export function TelemetryExportSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title="OpenTelemetry export" id="telemetry-export">
        <SettingsScopeNotice target="environment">
          Choose one environment to configure its telemetry exports.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <TelemetryExportForm key={environment.environmentId} />;
}

function TelemetryExportForm() {
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentId = environment?.environmentId;
  const canEdit = useAtomValue(
    serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId ?? null),
  );
  const canCheck =
    canEdit && environment?.serverConfig?.environment.capabilities.otlpEndpointCheck === true;
  const running = environment?.serverConfig?.observability;
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>(() =>
    Object.fromEntries(
      SIGNALS.flatMap((descriptor) => {
        const url = runningOverride(running, descriptor)?.url ?? saved[descriptor.key];
        return isHttpUrl(url) ? [[descriptor.key, { url, result: null }]] : [];
      }),
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };
  const overrides = SIGNALS.flatMap((descriptor) => {
    const override = runningOverride(running, descriptor);
    return override === undefined ? [] : [{ descriptor, override }];
  });
  const savedDestination = destinationOf(saved, overrides.length > 0);
  const [destinationDraft, setDestinationDraft] = useState<TelemetryDestination | null>(null);
  const destination = destinationDraft ?? savedDestination;
  const [presetDraft, setPresetDraft] = useState<typeof saved.preset | null>(null);
  const preset = presetDraft ?? initialPreset(destination, saved.preset);
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null);
  const agent =
    preset?._tag === "DatadogAgent" && agentDraft !== null ? parseAgentDraft(agentDraft) : null;
  const patch = observabilityPatch(
    saved,
    destination,
    agent?._tag === "Valid" ? agent.preset : preset,
    values,
  );
  const blocked = agent?._tag === "Invalid";
  const changed = patch !== null || blocked;

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!environmentId) return;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
    setChecks((previous) => {
      if (previous[key]?.url !== url || previous[key].result !== null) return previous;
      const next = { ...previous };
      if (response._tag === "Success") next[key] = { url, result: response.value };
      else delete next[key];
      return next;
    });
  };

  const checkEndpoint = (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!isHttpUrl(url)) return;
    setChecks((previous) => ({ ...previous, [key]: { url, result: null } }));
    void sendCheck(key, signal, url);
  };

  const sendPendingChecks = useEffectEvent(() => {
    for (const { key, signal } of SIGNALS) {
      const check = checks[key];
      if (check?.result === null) void sendCheck(key, signal, check.url);
    }
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- sends pending endpoint check requests once the environment can run them
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    if (canCheck) sendPendingChecks();
  }, [canCheck]);

  const signalKey = (signal: OtlpSignal) =>
    SIGNALS.find((descriptor) => descriptor.signal === signal)!.key;
  const datadogStatus = (signal: OtlpSignal) => {
    if (!canCheck || preset?._tag !== "Datadog") return null;
    return endpointStatus(
      datadogIntakeUrl(preset.site, signal),
      checks[signalKey(signal)],
      "datadog",
    );
  };

  return (
    <SettingsSection title="OpenTelemetry export" id="telemetry-export">
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!environment || saving || blocked) return;
          setSaving(true);
          setMessage(null);
          const result = await updateSettings({
            environmentId: environment.environmentId,
            input: { patch: { observability: patch ?? {} } },
          });
          setSaving(false);
          if (result._tag === "Success") {
            setDraft({});
            setDestinationDraft(null);
            setPresetDraft(null);
            setAgentDraft(null);
            setMessage("Saved. Restart the server to apply.");
          }
        }}
      >
        <Text as="p" variant="callout" tone="muted">
          Send traces, metrics, and logs to an OTLP HTTP receiver or to Datadog. Restart the server
          to apply. Environment variables override these settings.
        </Text>
        <div className="grid gap-1.5">
          <Label htmlFor="telemetry-destination">Destination</Label>
          <Select
            value={destination}
            disabled={saving || !canEdit}
            onValueChange={(value) => {
              if (!isDestination(value)) return;
              setDestinationDraft(value === savedDestination ? null : value);
              setPresetDraft(null);
              setAgentDraft(null);
              setMessage(null);
            }}
          >
            <SelectTrigger id="telemetry-destination" size="sm" aria-label="Destination">
              <SelectValue>{DESTINATION_LABELS[destination]}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {DESTINATIONS.map((option) => (
                <SelectItem key={option} hideIndicator value={option}>
                  {DESTINATION_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {preset?._tag === "Datadog" && environmentId !== undefined && (
          <DatadogExportFields
            environmentId={environmentId}
            preset={preset}
            disabled={saving || !canEdit}
            statuses={{
              traces: datadogStatus("traces"),
              metrics: datadogStatus("metrics"),
              logs: datadogStatus("logs"),
            }}
            onChange={(next) => {
              setPresetDraft(next);
              setMessage(null);
            }}
            onTest={
              canCheck
                ? (signal) =>
                    checkEndpoint(signalKey(signal), signal, datadogIntakeUrl(preset.site, signal))
                : null
            }
          />
        )}
        {destination !== "otlp" &&
          overrides.map(({ descriptor, override }) => (
            <Text as="p" key={descriptor.key} variant="callout" tone="muted" breakWords>
              {descriptor.label}: {override.label.toLowerCase()} to {override.url}
              {override.variable && (
                <>
                  {" "}
                  from{" "}
                  <Text as="code" variant="callout" tone="inherit" mono>
                    {override.variable}
                  </Text>
                </>
              )}
              , which overrides this destination.
            </Text>
          ))}
        {preset?._tag === "DatadogAgent" && (
          <DatadogAgentFields
            draft={agentDraft ?? agentDraftOf(preset)}
            problem={agent?._tag === "Invalid" ? agent.problem : null}
            disabled={saving || !canEdit}
            onChange={(next) => {
              setAgentDraft(next);
              setMessage(null);
            }}
          />
        )}
        {!canEdit && (
          <Text as="p" variant="callout" tone="muted">
            This connection lacks permission to change settings on{" "}
            {environment?.label ?? "the selected environment"}.
          </Text>
        )}
        {destination === "otlp" &&
          SIGNALS.map((descriptor) => {
            const { key, label, signal } = descriptor;
            const override = runningOverride(running, descriptor);
            const url = override?.url ?? values[key].trim();
            const check = canCheck ? endpointStatus(url, checks[key]) : null;
            const status = override
              ? {
                  label: check ? `${override.label} · ${check.label}` : override.label,
                  dot: check?.dot ?? "bg-muted-foreground/40",
                }
              : check;
            return (
              <div key={key} className="grid gap-1.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    {status && <ConnectionStatusDot dotClassName={status.dot} />}
                    <Label htmlFor={key}>{label} endpoint</Label>
                  </div>
                  {status && (
                    <Text variant="callout" tone="muted">
                      {status.label}
                    </Text>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    id={key}
                    size="compact"
                    type="url"
                    pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                    title="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
                    placeholder={`http://localhost:4318/v1/${signal}`}
                    value={values[key]}
                    disabled={saving || !canEdit}
                    onChange={(event) => {
                      const value = event.target.value;
                      // Clear restored drafts so later saves cannot overwrite another client's changes.
                      setDraft((previous) => {
                        const next = { ...previous, [key]: value };
                        if (value.trim() === saved[key]) delete next[key];
                        return next;
                      });
                      setMessage(null);
                    }}
                  />
                  {canCheck && (
                    <Button
                      type="button"
                      size="compact"
                      variant="outline"
                      disabled={!isHttpUrl(url) || checks[key]?.result === null}
                      onClick={() => void checkEndpoint(key, signal, url)}
                    >
                      Test
                    </Button>
                  )}
                </div>
                {(saved[key] !== (running?.[key] ?? "") || override?.variable) && (
                  <Text as="p" variant="callout" tone="muted" breakWords>
                    Running: {running?.[key] || "Disabled"}
                    {override?.variable && (
                      <>
                        {" "}
                        from{" "}
                        <Text as="code" variant="callout" tone="inherit" mono>
                          {override.variable}
                        </Text>
                      </>
                    )}
                  </Text>
                )}
              </div>
            );
          })}
        <div className="flex items-center justify-between gap-3">
          <Text as="p" role="status" variant="callout" tone="muted">
            {message}
          </Text>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!changed || saving || !canEdit}
              onClick={() => {
                setDraft({});
                setDestinationDraft(null);
                setPresetDraft(null);
                setAgentDraft(null);
                setMessage(null);
                if (!canCheck) return;
                for (const descriptor of SIGNALS) {
                  const { key, signal } = descriptor;
                  if (runningOverride(running, descriptor)) continue;
                  if (checks[key]?.url !== saved[key]) checkEndpoint(key, signal, saved[key]);
                }
              }}
            >
              Discard
            </Button>
            <Button type="submit" size="xs" disabled={!changed || blocked || saving || !canEdit}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}
