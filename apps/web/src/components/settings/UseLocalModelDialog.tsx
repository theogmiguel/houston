import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind, ServerProvider } from "@houston-app/contracts";
import type {
  InferenceDiscoveredServer,
  InferenceDiscoveryInput,
  InferenceDiscoveryResult,
} from "@houston-app/contracts/houston/inference";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import * as Result from "effect/Result";
import { CheckIcon, CpuIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { discoverInferenceServers, refreshInferenceServers } from "../../state/inference";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { Text } from "../ui/text";
import { isWindowsPlatform } from "../../lib/utils";
import { normalizeInferenceServerBaseUrl } from "./InferenceSettings.logic";
import {
  linkedModelSlug,
  localModelAgentChoices,
  planLocalModelSetup,
} from "./localModelSetup.logic";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

type Search =
  | { readonly status: "searching" }
  | { readonly status: "done"; readonly result: InferenceDiscoveryResult }
  | { readonly status: "failed"; readonly message: string };

type Progress =
  | { readonly step: "choose" }
  | { readonly step: "connecting"; readonly message: string }
  | { readonly step: "done"; readonly lines: ReadonlyArray<string> }
  | {
      readonly step: "incomplete";
      readonly title: string;
      readonly message: string;
      readonly canRetry: boolean;
    };

type Selection = { readonly baseUrl: string; readonly modelId: string };

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
};

/** A server already in use comes first, so reopening the dialog does not suggest a switch. */
function defaultSelection(servers: ReadonlyArray<InferenceDiscoveredServer>): Selection | null {
  const ready = servers.filter((server) => server.status === "ready");
  const pick = ready.find((server) => server.registeredServerId !== undefined) ?? ready[0];
  const model = pick?.models[0];
  return pick === undefined || model === undefined
    ? null
    : { baseUrl: pick.baseUrl, modelId: model.id };
}

/**
 * Finds model servers on one environment and makes one of its models the default for new threads:
 * register the server, link an agent to it, then pick the model the agent lists for it. Every
 * change is a normal Settings entry, reversible from Settings → Inference and Settings → Providers.
 */
export function UseLocalModelDialog({
  environmentId,
  machineLabel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? NO_PROVIDERS;
  const refreshServers = useAtomCommand(refreshInferenceServers, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const [searchInput, setSearchInput] = useState<InferenceDiscoveryInput>({});
  const discovery = useEnvironmentQuery(
    discoverInferenceServers({ environmentId, input: searchInput }),
  );
  const search: Search =
    discovery.error !== null
      ? { status: "failed", message: discovery.error }
      : discovery.data === undefined || discovery.data === null
        ? { status: "searching" }
        : { status: "done", result: discovery.data };
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Selection | null>(null);
  const [driver, setDriver] = useState<ProviderDriverKind | null>(null);
  const [progress, setProgress] = useState<Progress>({ step: "choose" });

  const runSearch = async (baseUrl?: string) => {
    setChosen(null);
    if (baseUrl === undefined) {
      await discovery.refresh();
      return;
    }
    setSearchInput({ baseUrl });
  };

  const servers = search.status === "done" ? search.result.servers : [];
  const selection =
    chosen !== null &&
    servers.some(
      (server) =>
        server.baseUrl === chosen.baseUrl &&
        server.models.some((model) => model.id === chosen.modelId),
    )
      ? chosen
      : defaultSelection(servers);
  const selectedServer = servers.find((server) => server.baseUrl === selection?.baseUrl);
  const choices =
    selectedServer === undefined
      ? []
      : localModelAgentChoices(selectedServer, providers, machineLabel);
  const chosenDriver =
    choices.find((choice) => choice.driver === driver && choice.unavailableReason === undefined)
      ?.driver ?? choices.find((choice) => choice.recommended)?.driver;
  const chosenAgent = choices.find((choice) => choice.driver === chosenDriver);
  const plan =
    selectedServer === undefined || chosenAgent === undefined
      ? null
      : planLocalModelSetup({
          settings,
          server: selectedServer,
          driver: chosenAgent.driver,
          agentLabel: chosenAgent.label,
          machineLabel,
        });

  const loadModelAndFinish = async (
    { instanceId, serverId, serverName }: NonNullable<typeof plan>,
    modelId: string,
    agentLabel: string,
  ) => {
    setProgress({ step: "connecting", message: `Loading the models ${agentLabel} lists…` });
    const refreshed = await refreshProviders({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
    const listed =
      refreshed._tag === "Success"
        ? refreshed.value.providers.find((provider) => provider.instanceId === instanceId)
        : undefined;
    if (listed?.installed === false) {
      setProgress({
        step: "incomplete",
        title: `${agentLabel} is not installed on ${machineLabel}`,
        message: `${serverName} is saved and linked. Install ${agentLabel}, or pick another agent and try again.`,
        canRetry: true,
      });
      return;
    }
    const slug = linkedModelSlug(listed?.models ?? [], serverId, modelId);
    if (slug === undefined) {
      setProgress({
        step: "incomplete",
        title: `${agentLabel} does not list ${modelId} yet`,
        message: `${agentLabel} is linked to ${serverName}, but its model list has not caught up. Try again in a moment.`,
        canRetry: true,
      });
      return;
    }
    const saved = await saveSettings({
      environmentId,
      input: { patch: { defaultModelSelection: { instanceId, model: slug } } },
    });
    if (saved._tag === "Failure") {
      setProgress({
        step: "incomplete",
        title: "The default model was not saved",
        message: failureMessage(saved),
        canRetry: true,
      });
      return;
    }
    setProgress({
      step: "done",
      lines: [
        `Model server: ${serverName}`,
        `Agent: ${agentLabel}`,
        `New threads on ${machineLabel} use ${modelId}`,
      ],
    });
  };

  const connect = async () => {
    if (plan === null || chosenAgent === undefined || selection === null) return;
    setProgress({ step: "connecting", message: "Saving…" });
    const patch =
      plan.serverConfig === null
        ? {}
        : { inferenceServers: { [plan.serverId]: plan.serverConfig } };
    if (plan.instanceMutation !== null || plan.serverConfig !== null) {
      const saved = await saveSettings({
        environmentId,
        input: {
          patch,
          ...(plan.instanceMutation === null
            ? {}
            : { providerInstanceMutation: plan.instanceMutation }),
        },
      });
      if (saved._tag === "Failure") {
        setProgress({
          step: "incomplete",
          title: "Nothing was saved",
          message: failureMessage(saved),
          canRetry: false,
        });
        return;
      }
    }
    setProgress({ step: "connecting", message: `Checking ${plan.serverName}…` });
    const checked = await refreshServers({ environmentId, input: { id: plan.serverId } });
    const snapshot =
      checked._tag === "Success"
        ? checked.value.servers.find((server) => server.id === plan.serverId)
        : undefined;
    if (snapshot?.status !== "ready") {
      setProgress({
        step: "incomplete",
        title: `${plan.serverName} is saved but not ready`,
        message: snapshot?.message ?? "It did not answer the check. Start it and try again.",
        canRetry: true,
      });
      return;
    }
    await loadModelAndFinish(plan, selection.modelId, chosenAgent.label);
  };

  const checkAddress = () => {
    const normalized = normalizeInferenceServerBaseUrl(address);
    if (Result.isFailure(normalized)) {
      setAddressError(normalized.failure);
      return;
    }
    setAddressError(null);
    void runSearch(normalized.success);
  };

  const busy = progress.step === "connecting";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Use a local model</DialogTitle>
          <DialogDescription>
            Find a model server on {machineLabel} (Ollama, LM Studio, llama.cpp, vLLM, SGLang,
            TensorFold) and run new threads on it. Nothing leaves your hardware.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {progress.step === "done" ? (
            <div className="grid gap-3">
              <ul className="grid gap-1.5">
                {progress.lines.map((line) => (
                  <li key={line} className="flex items-center gap-2">
                    <CheckIcon className="size-4 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
              <Text as="p" variant="caption" tone="muted">
                These are saved in Settings → Inference and Settings → Providers, where each can be
                changed or turned off.
              </Text>
            </div>
          ) : progress.step === "connecting" ? (
            <div className="flex items-center gap-2" role="status">
              <Spinner className="size-4" />
              <Text as="p" tone="muted">
                {progress.message}
              </Text>
            </div>
          ) : (
            <div className="grid gap-5">
              {progress.step === "incomplete" ? (
                <Alert variant="warning">
                  <AlertTitle>{progress.title}</AlertTitle>
                  <AlertDescription>{progress.message}</AlertDescription>
                </Alert>
              ) : null}
              <section className="grid gap-2" aria-labelledby="local-model-servers">
                <div className="flex items-center justify-between gap-2">
                  <Text as="h3" id="local-model-servers" weight="medium">
                    Inference servers on {machineLabel}
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={search.status === "searching"}
                    onClick={() => void runSearch()}
                  >
                    <SearchIcon className="size-3" aria-hidden />
                    Search again
                  </Button>
                </div>
                {search.status === "done" && !search.result.searchedListeningPorts ? (
                  <Text as="p" variant="caption" tone="muted">
                    {isWindowsPlatform(navigator.platform)
                      ? "Windows lists no listening ports here, so only the usual ports are searched. Enter another address below."
                      : "Listening ports were not found on this system, so only the usual ports were searched. Enter another address below."}
                  </Text>
                ) : null}
                {search.status === "searching" ? (
                  <div className="flex items-center gap-2" role="status">
                    <Spinner className="size-4" />
                    <Text as="p" tone="muted">
                      Looking for model servers on {machineLabel}…
                    </Text>
                  </div>
                ) : search.status === "failed" ? (
                  <Text as="p" tone="danger">
                    {search.message}
                  </Text>
                ) : servers.length === 0 ? (
                  <Text as="p" tone="muted">
                    No model server answered on {machineLabel}
                    {search.result.searchedListeningPorts ? "." : " at the usual ports."} Start one,
                    or enter its address below.
                  </Text>
                ) : (
                  <RadioGroup
                    aria-labelledby="local-model-servers"
                    value={
                      selection === null
                        ? ""
                        : JSON.stringify([selection.baseUrl, selection.modelId])
                    }
                    onValueChange={(value) => {
                      const [baseUrl, modelId] = JSON.parse(String(value)) as [string, string];
                      setChosen({ baseUrl, modelId });
                    }}
                  >
                    {servers.map((server) => (
                      <DiscoveredServerOption
                        key={server.baseUrl}
                        server={server}
                        registeredName={
                          server.registeredServerId === undefined
                            ? undefined
                            : (settings.inferenceServers[server.registeredServerId]?.displayName ??
                              server.registeredServerId)
                        }
                      />
                    ))}
                  </RadioGroup>
                )}
                <div className="grid gap-1.5 pt-1">
                  <Label htmlFor="local-model-address">Or enter its address</Label>
                  <div className="flex gap-2">
                    <Input
                      id="local-model-address"
                      placeholder="http://localhost:11434/v1"
                      value={address}
                      onChange={(event) => setAddress(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") checkAddress();
                      }}
                      aria-invalid={addressError !== null}
                    />
                    <Button
                      variant="outline"
                      disabled={address.trim() === "" || search.status === "searching"}
                      onClick={checkAddress}
                    >
                      Check
                    </Button>
                  </div>
                  {addressError === null ? null : (
                    <Text as="p" role="alert" variant="caption" tone="danger">
                      {addressError}
                    </Text>
                  )}
                </div>
              </section>
              {selectedServer !== undefined ? (
                <section className="grid gap-2" aria-labelledby="local-model-agent">
                  <Text as="h3" id="local-model-agent" weight="medium">
                    Agent
                  </Text>
                  <RadioGroup
                    aria-labelledby="local-model-agent"
                    value={chosenDriver ?? ""}
                    onValueChange={(value) => setDriver(value as ProviderDriverKind)}
                  >
                    {choices.map((choice) => (
                      <label key={choice.driver} className="flex items-start gap-2.5 p-2.5">
                        <Radio
                          value={choice.driver}
                          disabled={choice.unavailableReason !== undefined}
                        />
                        <span className="grid gap-0.5">
                          <span className="flex items-center gap-1.5">
                            {choice.label}
                            {choice.recommended ? (
                              <Badge variant="success">Recommended</Badge>
                            ) : null}
                          </span>
                          {choice.unavailableReason !== undefined ? (
                            <Text as="span" variant="caption" tone="muted">
                              {choice.unavailableReason}
                            </Text>
                          ) : choice.unchecked ? (
                            <Text as="span" variant="caption" tone="muted">
                              Not set up on {machineLabel} yet; checked when you connect.
                            </Text>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                </section>
              ) : null}
              {plan !== null && selection !== null && chosenAgent !== undefined ? (
                <Text as="p" variant="caption" tone="muted">
                  On {machineLabel}:{" "}
                  {plan.serverConfig === null
                    ? `use the model server ${plan.serverName}`
                    : `add the model server ${plan.serverName}`}
                  ,{" "}
                  {plan.instanceMutation === null
                    ? `use ${chosenAgent.label}, already linked to it`
                    : `link ${chosenAgent.label} to it`}
                  , and make {selection.modelId} the default for new threads.
                </Text>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {progress.step === "done" ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={busy || plan === null || selectedServer?.status !== "ready"}
                onClick={() => void connect()}
              >
                {busy ? <Spinner className="size-3.5" /> : <CpuIcon className="size-3.5" />}
                {progress.step === "incomplete" && progress.canRetry
                  ? "Try again"
                  : "Use this model"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DiscoveredServerOption({
  server,
  registeredName,
}: {
  readonly server: InferenceDiscoveredServer;
  readonly registeredName: string | undefined;
}) {
  const heading = [server.engine, server.baseUrl].filter(Boolean).join(" · ");
  return (
    <Card>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Text mono variant="caption" tone="muted">
            {heading}
          </Text>
          {registeredName === undefined ? null : (
            <Badge variant="outline">Added as {registeredName}</Badge>
          )}
          {server.status === "needs-key" ? <Badge variant="warning">Needs an API key</Badge> : null}
        </div>
        {server.status === "needs-key" ? (
          <Text as="p" variant="caption" tone="muted">
            It answered, but lists its models only with a key. Add it in Settings, Inference, with
            its key.
          </Text>
        ) : (
          server.models.map((model) => (
            <label key={model.id} className="flex items-center gap-2.5">
              <Radio value={JSON.stringify([server.baseUrl, model.id])} />
              <Text as="span">{model.id}</Text>
            </label>
          ))
        )}
      </div>
    </Card>
  );
}
