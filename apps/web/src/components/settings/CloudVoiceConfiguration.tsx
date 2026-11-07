import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@houston-app/client-runtime/connection";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@houston-app/client-runtime/secret-request";
import {
  getCloudSpeechKeys,
  getCloudSpeechModels,
  setCloudSpeechKey,
} from "@houston-app/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CLOUD_SPEECH_PROVIDER_NAMES,
  CloudSpeechApiKey,
  CloudSpeechModelId,
  isSecretReference,
  SETTINGS_SECRET_MAX_BYTES,
  type CloudSpeechModel,
  type CloudSpeechProvider,
  type SecretProviderId,
  type SettingsSecretValue,
  type VoiceTranscriptionDestination,
} from "@houston-app/contracts";
import { cloudSpeechDisclosure } from "@houston-app/shared/speech";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";
import { Atom, AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { runtime } from "../../lib/runtime";
import {
  chooseAudioDestination,
  pendingCloudAudioChoice,
  useAudioGrant,
} from "../../speech/voiceConsent";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  useComboboxFilter,
} from "../ui/combobox";
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
import { Text } from "../ui/text";
import { SecretInput } from "./SecretInput";
import { SecretSourceSelect } from "./SecretSourceInput";

const isApiKey = Schema.is(CloudSpeechApiKey);
const isModelId = Schema.is(CloudSpeechModelId);
type CloudDestination = Extract<VoiceTranscriptionDestination, { kind: "cloud" }>;

// One atom per dialog instance, not a family: key presence must be read fresh each time it opens.
function useCloudRead<A, E>(
  prepared: PreparedConnection | null,
  read: (prepared: PreparedConnection) => Effect.Effect<A, E, HttpClient.HttpClient>,
) {
  const make = (connection: PreparedConnection | null) => ({
    prepared: connection,
    atom: Atom.make(
      connection
        ? Effect.tryPromise(() => runtime.runPromise(read(connection)))
        : Effect.succeed(null),
    ),
  });
  const [current, setCurrent] = useState(() => make(prepared));
  if (current.prepared !== prepared) setCurrent(make(prepared));
  return [useAtomValue(current.atom), useAtomRefresh(current.atom)] as const;
}

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  current,
}: {
  models: ReadonlyArray<CloudSpeechModel>;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  /** The grant's model, flagged when the catalog no longer lists it. */
  current: string | undefined;
}) {
  const { contains } = useComboboxFilter();
  const selected = models.find((model) => model.id === value) ?? null;
  const delisted = current !== undefined && !models.some((model) => model.id === current);
  return (
    <div className="grid gap-1">
      <Combobox
        items={models}
        itemToStringLabel={(model: CloudSpeechModel) => model.name}
        itemToStringValue={(model: CloudSpeechModel) => model.id}
        filter={(model: CloudSpeechModel, query) =>
          contains(model.name, query) || contains(model.id, query)
        }
        value={selected}
        onValueChange={(model) => onChange(model?.id ?? "")}
        autoHighlight
        disabled={disabled}
      >
        <ComboboxInput
          id="voice-cloud-model"
          aria-label="OpenRouter model"
          placeholder="Search transcription models"
          autoFocus
          size="sm"
        />
        <ComboboxPopup>
          <ComboboxEmpty>No transcription model matches.</ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {(model: CloudSpeechModel) => (
              <ComboboxItem key={model.id} value={model}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{model.name}</span>
                  <Text variant="caption" tone="muted" truncate>
                    {model.id}
                  </Text>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {delisted ? (
        <Text as="p" variant="callout" tone="danger" role="alert">
          OpenRouter no longer lists {current}. Dictation stays off until you choose another model.
        </Text>
      ) : null}
    </div>
  );
}

/** Opts this device into `provider` through `environment` and saves its key there; nothing applies before the save succeeds. */
export function CloudVoiceConfiguration({
  environment,
  provider,
  active,
  close,
}: {
  environment: Pick<EnvironmentPresentation, "environmentId" | "label" | "serverConfig">;
  provider: CloudSpeechProvider;
  /** This device already sends to this provider through this environment. */
  active: boolean;
  close: () => void;
}) {
  const id = environment.environmentId;
  const name = CLOUD_SPEECH_LABELS[provider];
  const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
  const routed = provider === "openrouter";
  const formId = useId();
  const prepared = Option.getOrNull(usePreparedConnection(id));
  const canUse = useEnvironmentScope(id, AuthOrchestrationOperateScope);
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const connected = canUse && prepared !== null;
  const [presence, refresh] = useCloudRead(connected ? prepared : null, getCloudSpeechKeys);
  const [models, refreshModels] = useCloudRead(
    routed && connected ? prepared : null,
    getCloudSpeechModels,
  );
  const grant = useAudioGrant();
  const currentModel =
    active && grant?.destination.kind === "cloud" && grant.destination.provider === "openrouter"
      ? grant.destination.model
      : undefined;
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [model, setModel] = useState(currentModel ?? "");
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const [draft, setDraft] = useState("");
  const saved = AsyncResult.isSuccess(presence) ? presence.value?.[provider] : undefined;
  const sources =
    environment.serverConfig?.secretReferences === true
      ? configuredSecretSources(environment.serverConfig.settings?.secretProviders ?? {})
      : [];
  const source = sources.find((candidate) => candidate.id === sourceId);
  // Blank keeps the saved key; an entry is a literal key or a reference in the chosen provider's syntax.
  const typed = draft.trim();
  const credential: SettingsSecretValue | undefined =
    sourceId !== null
      ? source && typed
        ? secretRequestReference(source, typed)
        : undefined
      : isApiKey(typed)
        ? typed
        : undefined;
  const keyInvalid = typed !== "" && credential === undefined;
  const keyProblem =
    sourceId !== null
      ? (source?.invalidReferenceMessage ?? "Enter a valid secret reference.")
      : `Enter a ${company} API key of at most ${SETTINGS_SECRET_MAX_BYTES} bytes, not a URL or secret reference.`;
  const listedModels = AsyncResult.isSuccess(models) ? (models.value?.models ?? null) : null;
  const modelChosen =
    !routed || (isModelId(model) && (listedModels?.some((m) => m.id === model) ?? false));
  const modelChanged = routed && model !== (currentModel ?? "");
  const keyReady = typed ? credential !== undefined : saved === true;
  const canSubmit =
    modelChosen && keyReady && (!active || modelChanged || credential !== undefined);
  // Without settings access a person can use a saved key but never read or change it.
  const editingKey = canManage && saved !== undefined;
  const destination = (): CloudDestination =>
    routed && isModelId(model)
      ? { kind: "cloud", provider: "openrouter", environmentId: id, model }
      : { kind: "cloud", provider: provider as "openai" | "xai", environmentId: id };

  const saveKey = async (value: SettingsSecretValue | null, thenEnable: boolean) => {
    if (!prepared || !canManage || busy) return;
    setError("");
    setBusy(true);
    try {
      const confirm = thenEnable ? pendingCloudAudioChoice(destination()) : null;
      await runtime.runPromise(setCloudSpeechKey(prepared, provider, value));
      refresh();
      confirm?.();
      close();
    } catch {
      setError("Couldn't save this change. Check your connection and try again.");
    }
    setBusy(false);
  };
  const submit = () => {
    if (!canSubmit || busy) return;
    const grantChanges = !active || modelChanged;
    if (credential !== undefined) return void saveKey(credential, grantChanges);
    // A model change or a saved key never writes to the environment.
    if (grantChanges) chooseAudioDestination(destination());
    close();
  };

  const keyField = (
    <div className="grid gap-2">
      <Label htmlFor="voice-cloud-key">{saved ? "Replace API key" : "API key"}</Label>
      <div className="flex min-w-0 items-start gap-2">
        {sources.length > 0 && (
          <SecretSourceSelect
            value={sourceId}
            sources={sources}
            label={`${company} API key`}
            disabled={busy}
            onValueChange={(next) => {
              setSourceId(next);
              setDraft("");
              setError("");
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          {sourceId !== null ? (
            <Input
              key={sourceId}
              id="voice-cloud-key"
              aria-label={`${company} API key reference`}
              aria-invalid={keyInvalid}
              placeholder={source?.referencePlaceholder}
              value={draft}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <SecretInput
              id="voice-cloud-key"
              aria-label={`${company} API key`}
              aria-invalid={keyInvalid}
              placeholder="Enter API key"
              value={draft}
              configured={saved === true}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </div>
      </div>
      <Text as="p" variant="callout" tone={keyInvalid ? "danger" : "muted"}>
        {keyInvalid
          ? keyProblem
          : `Anyone with dictation access to ${environment.label} can bill this key.`}
      </Text>
    </div>
  );

  const body = !connected ? (
    <p>Connect to {environment.label} with dictation access to continue.</p>
  ) : AsyncResult.isFailure(presence) ? (
    <Button size="sm" variant="outline" onClick={refresh}>
      Retry loading API key
    </Button>
  ) : saved === undefined ? (
    <p role="status">Checking for an API key…</p>
  ) : (
    <form
      id={formId}
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {routed && (
        <div className="grid gap-2">
          <Label htmlFor="voice-cloud-model">Model</Label>
          {listedModels ? (
            <ModelPicker
              models={listedModels}
              value={model}
              onChange={setModel}
              disabled={busy}
              current={currentModel}
            />
          ) : AsyncResult.isFailure(models) ? (
            <Button size="sm" variant="outline" type="button" onClick={refreshModels}>
              Retry loading models
            </Button>
          ) : (
            <p role="status">Loading transcription models…</p>
          )}
        </div>
      )}
      {editingKey ? (
        keyField
      ) : !saved ? (
        <p>Ask an administrator on {environment.label} to add an API key.</p>
      ) : null}
    </form>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {remove
              ? `Remove the ${company} key?`
              : active
                ? `Manage ${name}`
                : `Use ${name} for dictation?`}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? `Everyone using ${name} for dictation on ${environment.label} will lose access.`
              : cloudSpeechDisclosure(provider, environment.label)}
          </DialogDescription>
        </DialogHeader>
        {!remove && <DialogPanel>{body}</DialogPanel>}
        {error && (
          <Text as="p" variant="callout" tone="danger" role="alert" className="px-6">
            {error}
          </Text>
        )}
        <DialogFooter>
          {connected && canManage && saved && !remove && (
            <div className="sm:mr-auto">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setRemove(true)}
              >
                Remove key…
              </Button>
            </div>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {connected &&
            (remove ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void saveKey(null, false)}
              >
                Remove key
              </Button>
            ) : saved !== undefined && (saved || canManage) ? (
              <Button type="submit" form={formId} size="sm" disabled={busy || !canSubmit}>
                {active ? "Save" : "Save and enable"}
              </Button>
            ) : null)}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
