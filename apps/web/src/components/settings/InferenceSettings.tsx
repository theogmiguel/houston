import { AuthSettingsWriteScope, type EnvironmentId } from "@houston-app/contracts";
import { useAtomValue } from "@effect/atom-react";
import type {
  InferenceDiscoveredServer,
  InferenceServerId,
  InferenceServerModel,
  InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import { CpuIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import {
  checkInferenceModelImages,
  INFERENCE_SERVERS_EMPTY_INPUT,
  inferenceServers,
  refreshInferenceServers,
  removeInferenceServer,
  saveInferenceServer,
} from "../../state/inference";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Text } from "../ui/text";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FindInferenceServerDialog } from "./FindInferenceServerDialog";
import { FindInferenceServersDialog } from "./FindInferenceServersDialog";
import { InferenceServerDialog } from "./InferenceServerDialog";
import {
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerOffers,
  inferenceServerOriginHost,
  type InferenceServerDraft,
  type InferenceServerOffer,
} from "./InferenceSettings.logic";
import { knownServerModelIds } from "./localModelSetup.logic";
import { UseLocalModelDialog } from "./UseLocalModelDialog";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STATUS_LABELS = {
  checking: "Checking",
  ready: "Ready",
  unreachable: "Unreachable",
  error: "Error",
} as const satisfies Record<InferenceServerSnapshot["status"], string>;

const STATUS_BADGE_VARIANTS = {
  checking: "outline",
  ready: "success",
  unreachable: "warning",
  error: "error",
} as const satisfies Record<InferenceServerSnapshot["status"], string>;

type InferenceDialog =
  | {
      readonly mode: "add";
      readonly initialDraft?: InferenceServerDraft;
      readonly note?: string;
    }
  | { readonly mode: "edit"; readonly server: InferenceServerSnapshot }
  | { readonly mode: "find" };

function formatTokens(value: number): string {
  return `${value.toLocaleString("en-US")} tokens`;
}

function modelDetails(model: InferenceServerModel): string {
  if (model.servedContextWindow !== undefined) return formatTokens(model.servedContextWindow);
  if (model.trainedContextWindow !== undefined) {
    return `${formatTokens(model.trainedContextWindow)} trained`;
  }
  return "Context window not reported";
}

function failureMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message === "" ? fallback : message;
}

/** Reads the selections that name a server's models, then lets the user find where it moved. */
function RepairServerDialog({
  environmentId,
  server,
  onChangeAddress,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly server: InferenceServerSnapshot;
  readonly onChangeAddress: () => void;
  readonly onClose: () => void;
}) {
  const selections = useEnvironmentSettings(environmentId, (settings) => [
    settings.defaultModelSelection,
    settings.textGenerationModelSelection,
  ]);
  return (
    <FindInferenceServerDialog
      environmentId={environmentId}
      id={server.id}
      name={server.displayName}
      config={{
        ...(server.displayName === undefined ? {} : { displayName: server.displayName }),
        baseUrl: server.baseUrl,
        enabled: server.enabled,
        ...(server.maxConcurrentRequests === undefined
          ? {}
          : { maxConcurrentRequests: server.maxConcurrentRequests }),
        ...(server.fallbackServerId === undefined
          ? {}
          : { fallbackServerId: server.fallbackServerId }),
      }}
      knownModelIds={knownServerModelIds(server.id, server.models, selections)}
      onChangeAddress={onChangeAddress}
      onClose={onClose}
    />
  );
}

/** Servers registered on another connected machine that this one lacks, each one click to add. */
function InferenceServerOffersFrom({
  origin,
  current,
  targetLabel,
  onAdd,
}: {
  readonly origin: EnvironmentPresentation;
  readonly current: ReadonlyArray<InferenceServerSnapshot>;
  readonly targetLabel: string;
  readonly onAdd: (offer: InferenceServerOffer, note: string) => void;
}) {
  const originServers = useEnvironmentSettings(origin.environmentId, (settings) => {
    const servers: Record<string, { baseUrl: string; enabled: boolean; displayName?: string }> = {};
    for (const [id, config] of Object.entries(settings.inferenceServers)) {
      servers[id] = {
        baseUrl: config.baseUrl,
        enabled: config.enabled,
        ...(config.displayName === undefined ? {} : { displayName: config.displayName }),
      };
    }
    return servers;
  });
  const originSnapshots = useEnvironmentQuery(
    inferenceServers({
      environmentId: origin.environmentId,
      input: INFERENCE_SERVERS_EMPTY_INPUT,
    }),
  );
  if (origin.serverConfig?.inferenceServers !== true) {
    return (
      <SettingsRow
        title={`${origin.label} cannot share model servers`}
        description={`${origin.label} runs a server version without Settings → Inference. Update it there to share its model servers with ${targetLabel}.`}
      />
    );
  }
  const currentConfigs = Object.fromEntries(
    current.map((server) => [server.id, { baseUrl: server.baseUrl, enabled: server.enabled }]),
  );
  const keyedServerIds = new Set(
    (originSnapshots.data?.servers ?? [])
      .filter((server) => server.hasApiKey === true)
      .map((server) => server.id),
  );
  const offers = inferenceServerOffers(currentConfigs, {
    servers: originServers,
    host: inferenceServerOriginHost(origin.label, origin.serverConfig?.directEndpoints),
    keyedServerIds,
  });
  return offers.map((offer) => (
    <SettingsRow
      key={`${origin.environmentId}:${offer.id}`}
      title={`${offer.name} on ${origin.label}`}
      description={`Use it from ${targetLabel} at ${offer.baseUrl}.`}
      control={
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            onAdd(
              offer,
              offer.needsKey
                ? `Copied from ${origin.label}; enter its API key again, since keys are never copied between machines.`
                : `Copied from ${origin.label}. Its API key, if any, is not copied between machines.`,
            )
          }
        >
          <PlusIcon className="size-3" aria-hidden />
          Add here
        </Button>
      }
    />
  ));
}

function ServerRow({
  environmentId,
  server,
  now,
  canWrite,
  servers,
  onEdit,
  onCheckAgain,
  onFind,
  onRemove,
  onFallbackChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly server: InferenceServerSnapshot;
  readonly now: number;
  readonly canWrite: boolean;
  readonly servers: ReadonlyArray<InferenceServerSnapshot>;
  readonly onEdit: () => void;
  readonly onCheckAgain: () => void;
  readonly onFind: (() => void) | undefined;
  readonly onRemove: () => void;
  readonly onFallbackChange: (fallbackServerId: InferenceServerId | null) => void;
}) {
  const down = server.status === "unreachable" || server.status === "error";
  const queue = server.gatewayQueue;
  const cache = server.promptCache;
  const details = [
    server.engine,
    server.load === undefined
      ? undefined
      : `${server.load.running} running, ${server.load.waiting} waiting`,
    server.maxConcurrentRequests === undefined
      ? undefined
      : `${server.maxConcurrentRequests} at once`,
    queue === undefined || (queue.active.length === 0 && queue.waiting.length === 0)
      ? undefined
      : `Houston queue: ${queue.active.length} running, ${queue.waiting.length} waiting of ${queue.capacity}`,
    cache === undefined
      ? undefined
      : cache.status === "saturated-falling"
        ? "Prompt cache (TensorFold): full, cached share falling"
        : `Prompt cache (TensorFold): ${cache.states ?? 0} states${cache.recentCachedShare === undefined ? "" : `, ${Math.round(cache.recentCachedShare * 100)}% reused`}`,
  ].filter((entry): entry is string => entry !== undefined);
  return (
    <SettingsRow
      id={`inference-server-${server.id}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {server.displayName}
          <Badge variant={STATUS_BADGE_VARIANTS[server.status]}>
            {STATUS_LABELS[server.status]}
          </Badge>
        </span>
      }
      description={
        <span className="flex flex-col gap-1">
          <Text breakWords>{server.baseUrl}</Text>
          <span className="flex flex-wrap gap-x-2">
            {details.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
            <span>
              {server.checkedAt === null
                ? "Not checked yet"
                : `Checked ${formatRelativeTimeLabel(server.checkedAt, now)}`}
            </span>
          </span>
        </span>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Select
            value={server.fallbackServerId ?? "none"}
            onValueChange={(value) =>
              onFallbackChange(value === "none" ? null : (String(value) as InferenceServerId))
            }
            disabled={!canWrite}
          >
            <SelectTrigger aria-label={`Fallback for ${server.displayName}`} className="min-w-40">
              <SelectValue>
                {server.fallbackServerId === undefined
                  ? "No fallback"
                  : (servers.find((candidate) => candidate.id === server.fallbackServerId)
                      ?.displayName ?? server.fallbackServerId)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="none">No fallback</SelectItem>
              {servers
                .filter((candidate) => candidate.id !== server.id && candidate.enabled)
                .map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.displayName}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
          <Button size="compact" variant="outline" disabled={!canWrite} onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="compact"
            variant="ghost-destructive"
            disabled={!canWrite}
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      }
    >
      {server.message === undefined ? null : (
        <div className="grid gap-1 px-4 pb-2">
          <Text as="p" variant="caption" tone="muted">
            {server.message}
          </Text>
          {down && canWrite ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Button size="xs" variant="outline" onClick={onCheckAgain}>
                Check again
              </Button>
              {onFind === undefined ? null : (
                <Button size="xs" variant="outline" onClick={onFind}>
                  <SearchIcon className="size-3" aria-hidden />
                  Find server
                </Button>
              )}
              <Button size="xs" variant="outline" onClick={onEdit}>
                Change address
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {server.recentFailure === undefined ? null : (
        <div className="px-4 pb-2">
          <Text as="p" variant="caption" tone="danger">
            Last request {server.recentFailure.status} at{" "}
            {formatRelativeTimeLabel(server.recentFailure.at, now)}
            {server.recentFailure.advice === undefined ? "" : `: ${server.recentFailure.advice}`}
          </Text>
        </div>
      )}
      {server.models.length === 0 ? null : (
        <ul className="flex flex-col gap-1 px-4 pb-3">
          {server.models.map((model) => (
            <li key={model.id} className="flex flex-wrap items-baseline gap-x-2">
              <Text mono breakWords>
                {model.id}
              </Text>
              <Text tone="muted">{modelDetails(model)}</Text>
              <InferenceModelImages
                environmentId={environmentId}
                serverId={server.id}
                model={model}
                canCheck={server.status === "ready"}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

// A server can swap the weights behind a model id, so a day-old check is offered again.
const IMAGE_CHECK_STALE_MS = 24 * 60 * 60_000;

/** Whether a model reads images, and a way to check by sending it test images. */
function InferenceModelImages({
  environmentId,
  serverId,
  model,
  canCheck,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverId: InferenceServerId;
  readonly model: InferenceServerModel;
  readonly canCheck: boolean;
}) {
  const check = useAtomCommand(checkInferenceModelImages, { label: "check images" });
  const canRun = useAtomValue(checkInferenceModelImages.permissionAtom(environmentId));
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const now = Date.parse(useNowMinute());
  const image = model.capabilities?.image;
  const stale =
    image?.checkedAt !== undefined && now - Date.parse(image.checkedAt) > IMAGE_CHECK_STALE_MS;
  const runCheck = async () => {
    setChecking(true);
    setNote(null);
    const result = await check({ environmentId, input: { serverId, model: model.id } });
    setChecking(false);
    // A verdict arrives with the server's next snapshot; only an inconclusive check needs words.
    if (result._tag === "Success" && result.value.outcome === "unknown") {
      setNote(result.value.detail);
    }
  };
  return (
    <>
      {image === undefined ? null : (
        <Badge size="sm" variant={image.supported ? "info" : "outline"}>
          {image.supported ? "Reads images" : "Text only"}
        </Badge>
      )}
      {canCheck && canRun && (image === undefined || stale) ? (
        <Button size="xs" variant="ghost" disabled={checking} onClick={() => void runCheck()}>
          {checking ? "Checking images" : image ? "Check images again" : "Check images"}
        </Button>
      ) : null}
      {note === null ? null : (
        <Text as="span" variant="caption" tone="warning">
          {note}
        </Text>
      )}
    </>
  );
}

export function InferenceSettingsPanel({
  openLocalSetup = false,
  repairServerId,
}: {
  /** Opens "Use a local model" on arrival, as links from elsewhere ask. */
  readonly openLocalSetup?: boolean;
  /** Opens "Find" for this server on arrival, as the composer's outage notice asks. */
  readonly repairServerId?: string | undefined;
}) {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const environmentLabel = environment?.label ?? "this environment";
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : inferenceServers({ environmentId, input: INFERENCE_SERVERS_EMPTY_INPUT }),
  );
  const refresh = useAtomCommand(refreshInferenceServers, { reportFailure: false });
  const remove = useAtomCommand(removeInferenceServer, { reportFailure: false });
  const save = useAtomCommand(saveInferenceServer, { reportFailure: false });
  const [dialog, setDialog] = useState<InferenceDialog | null>(null);
  const [localSetupOpen, setLocalSetupOpen] = useState(openLocalSetup);
  const [finding, setFinding] = useState<InferenceServerId | null>(
    repairServerId === undefined ? null : (repairServerId as InferenceServerId),
  );
  const [removeTarget, setRemoveTarget] = useState<InferenceServerSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const now = Date.parse(useNowMinute());
  const servers = query.data?.servers ?? [];
  const existingIds = new Set<string>(servers.map((server) => server.id));
  const { environments } = useEnvironments();
  const otherMachines = environments.filter(
    (other) => other.environmentId !== environmentId && other.connection.phase === "connected",
  );

  const runRefresh = async () => {
    if (environmentId === null || refreshing) return;
    setRefreshing(true);
    setFailure(null);
    const outcome = await refresh({ environmentId, input: {} });
    setRefreshing(false);
    if (outcome._tag === "Failure") {
      setFailure(failureMessage(outcome.cause, "The servers could not be checked."));
      return;
    }
    query.refresh();
  };

  const runRemove = async () => {
    if (environmentId === null || removeTarget === null || removing) return;
    setRemoving(true);
    setFailure(null);
    const outcome = await remove({ environmentId, input: { id: removeTarget.id } });
    setRemoving(false);
    if (outcome._tag === "Failure") {
      setFailure(failureMessage(outcome.cause, "The server could not be removed."));
      return;
    }
    setRemoveTarget(null);
    query.refresh();
  };

  const pickDiscovered = (server: InferenceDiscoveredServer) => {
    if (server.registeredServerId !== undefined) {
      const registered = servers.find((candidate) => candidate.id === server.registeredServerId);
      if (registered !== undefined) {
        setDialog({ mode: "edit", server: registered });
        return;
      }
    }
    setDialog({
      mode: "add",
      initialDraft: { ...EMPTY_INFERENCE_SERVER_DRAFT, baseUrl: server.baseUrl },
    });
  };

  const searchTarget = searchableSetting("inference-servers");
  const repairServer =
    finding === null ? undefined : servers.find((server) => server.id === finding);

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection id={searchTarget.id} title="Inference servers">
          <SettingsRow
            title="No environment connected"
            description="Connect an environment to register the model servers it can reach."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchTarget.id}
        title="Inference servers"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-1">
            {servers.length === 0 ? null : (
              <Button
                size="compact"
                variant="ghost-muted"
                disabled={refreshing}
                onClick={() => void runRefresh()}
              >
                <RefreshIcon refreshing={refreshing} />
                {refreshing ? "Checking" : "Refresh"}
              </Button>
            )}
            <Button
              size="compact"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setLocalSetupOpen(true)}
            >
              <CpuIcon />
              Use a local model
            </Button>
            <Button
              size="compact"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setDialog({ mode: "find" })}
            >
              <SearchIcon />
              Find servers
            </Button>
            <Button
              size="compact"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setDialog({ mode: "add" })}
            >
              <PlusIcon />
              Add server
            </Button>
          </div>
        }
      >
        {failure === null ? null : (
          <div className="px-4 py-2">
            <Text as="p" role="alert" variant="caption" tone="danger">
              {failure}
            </Text>
          </div>
        )}
        {serverQueryFailure(query.error)}
        {servers.length === 0 ? (
          <SettingsRow
            title="No model servers registered"
            description={`Register OpenAI-compatible servers on ${environmentLabel} or your network: Ollama, LM Studio, llama.cpp, vLLM or SGLang. localhost means ${environmentLabel} itself.`}
            control={
              canWrite ? (
                <Button size="sm" onClick={() => setLocalSetupOpen(true)}>
                  <CpuIcon className="size-3" aria-hidden />
                  Find local models
                </Button>
              ) : null
            }
          />
        ) : environmentId === null ? null : (
          servers.map((server) => (
            <ServerRow
              key={server.id}
              environmentId={environmentId}
              server={server}
              now={now}
              canWrite={canWrite}
              servers={servers}
              onEdit={() => setDialog({ mode: "edit", server })}
              onCheckAgain={() => void runRefresh()}
              onFind={canWrite ? () => setFinding(server.id) : undefined}
              onRemove={() => setRemoveTarget(server)}
              onFallbackChange={(fallbackServerId) => {
                if (environmentId === null) return;
                void save({
                  environmentId,
                  input: {
                    id: server.id,
                    displayName: server.displayName,
                    baseUrl: server.baseUrl,
                    enabled: server.enabled,
                    ...(server.maxConcurrentRequests === undefined
                      ? {}
                      : { maxConcurrentRequests: server.maxConcurrentRequests }),
                    fallbackServerId,
                  },
                }).then(() => query.refresh());
              }}
            />
          ))
        )}
        {canWrite
          ? otherMachines.map((origin) => (
              <InferenceServerOffersFrom
                key={origin.environmentId}
                origin={origin}
                current={servers}
                targetLabel={environmentLabel}
                onAdd={(offer, note) =>
                  setDialog({
                    mode: "add",
                    initialDraft: {
                      ...EMPTY_INFERENCE_SERVER_DRAFT,
                      name: offer.name,
                      baseUrl: offer.baseUrl,
                    },
                    note,
                  })
                }
              />
            ))
          : null}
        {canWrite ? null : (
          <div className="px-4 py-2">
            <Text as="p" variant="caption" tone="muted">
              This connection cannot change settings on {environmentLabel}.
            </Text>
          </div>
        )}
      </SettingsSection>

      {localSetupOpen && canWrite ? (
        <UseLocalModelDialog
          environmentId={environmentId}
          machineLabel={environmentLabel}
          onClose={() => setLocalSetupOpen(false)}
        />
      ) : null}
      {repairServer === undefined || !canWrite ? null : (
        <RepairServerDialog
          environmentId={environmentId}
          server={repairServer}
          onChangeAddress={() => {
            setFinding(null);
            setDialog({ mode: "edit", server: repairServer });
          }}
          onClose={() => setFinding(null)}
        />
      )}
      {dialog?.mode === "add" ? (
        <InferenceServerDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          existingIds={existingIds}
          {...(dialog.initialDraft === undefined ? {} : { initialDraft: dialog.initialDraft })}
          {...(dialog.note === undefined ? {} : { note: dialog.note })}
          onClose={() => setDialog(null)}
          onSaved={() => query.refresh()}
        />
      ) : null}
      {dialog?.mode === "edit" ? (
        <InferenceServerDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          existing={dialog.server}
          existingIds={existingIds}
          onClose={() => setDialog(null)}
          onSaved={() => query.refresh()}
        />
      ) : null}
      {dialog?.mode === "find" ? (
        <FindInferenceServersDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onClose={() => setDialog(null)}
          onPick={pickDiscovered}
        />
      ) : null}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its saved API key is deleted and the server stops being checked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" disabled={removing} onClick={() => void runRemove()}>
              {removing ? "Removing…" : "Remove server"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}

function serverQueryFailure(error: string | null) {
  return error === null ? null : (
    <div className="px-4 py-2">
      <Text as="p" role="alert" variant="caption" tone="danger">
        {error}
      </Text>
    </div>
  );
}
