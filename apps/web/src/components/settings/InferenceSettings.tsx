import { AuthSettingsWriteScope } from "@houston-app/contracts";
import type {
  InferenceDiscoveredServer,
  InferenceServerId,
  InferenceServerModel,
  InferenceServerSnapshot,
} from "@houston-app/contracts/houston/inference";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentScope } from "../../state/session";
import {
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
import { FindInferenceServersDialog } from "./FindInferenceServersDialog";
import { InferenceServerDialog } from "./InferenceServerDialog";
import { EMPTY_INFERENCE_SERVER_DRAFT, type InferenceServerDraft } from "./InferenceSettings.logic";
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
  | { readonly mode: "add"; readonly initialDraft?: InferenceServerDraft }
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

function ServerRow({
  server,
  now,
  canWrite,
  servers,
  onEdit,
  onRemove,
  onFallbackChange,
}: {
  readonly server: InferenceServerSnapshot;
  readonly now: number;
  readonly canWrite: boolean;
  readonly servers: ReadonlyArray<InferenceServerSnapshot>;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onFallbackChange: (fallbackServerId: InferenceServerId | null) => void;
}) {
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
        <div className="px-4 pb-2">
          <Text as="p" variant="caption" tone="muted">
            {server.message}
          </Text>
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
              {model.capabilities?.image?.supported ? (
                <Badge size="sm" variant="info">
                  Reads images
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}

export function InferenceSettingsPanel() {
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
  const [removeTarget, setRemoveTarget] = useState<InferenceServerSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const now = Date.parse(useNowMinute());
  const servers = query.data?.servers ?? [];
  const existingIds = new Set<string>(servers.map((server) => server.id));

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
          />
        ) : (
          servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              now={now}
              canWrite={canWrite}
              servers={servers}
              onEdit={() => setDialog({ mode: "edit", server })}
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
        {canWrite ? null : (
          <div className="px-4 py-2">
            <Text as="p" variant="caption" tone="muted">
              This connection cannot change settings on {environmentLabel}.
            </Text>
          </div>
        )}
      </SettingsSection>

      {dialog?.mode === "add" ? (
        <InferenceServerDialog
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          existingIds={existingIds}
          {...(dialog.initialDraft === undefined ? {} : { initialDraft: dialog.initialDraft })}
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
