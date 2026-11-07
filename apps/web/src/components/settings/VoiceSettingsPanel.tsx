import type { PreparedConnection } from "@houston-app/client-runtime/connection";
import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  updateEnvironmentSpeechAcceleration,
  updateEnvironmentSpeechModelUnloadTimeout,
} from "@houston-app/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  ProviderDriverKind,
  type EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type ProjectId,
  type SpeechAcceleration,
  type SpeechCustomWords,
  type SpeechModelUnloadTimeout,
  type VoiceShortcutMode,
} from "@houston-app/contracts";
import { createModelSelection } from "@houston-app/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@houston-app/shared/serverSettings";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  AudioLinesIcon,
  CheckIcon,
  DownloadIcon,
  LanguagesIcon,
  MicIcon,
  RefreshCwIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { runtime } from "../../lib/runtime";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { listBrowserMicrophones, type BrowserMicrophone } from "../../speech/browserMicrophones";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import {
  chooseAudioDestination,
  chooseTranscriptCleanup,
  useCleanupGrant,
} from "../../speech/voiceConsent";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { ComposerSpeechTray } from "../chat/ComposerSpeechButton";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceModelDownloadProgress } from "../ui/voice-model-download-progress";
import { AdvancedSettings } from "./AdvancedSettings";
import { MicrophoneTest } from "./MicrophoneTest";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { languageLabel, SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { LanguageRow, ModelBenchmarks, orderSpeechLanguages } from "./SpeechModelComparison";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OFF = "off";
const SYSTEM_DEFAULT = "system-default";
/** The wire schema holds at most this many dictionary entries per list. */
const DICTIONARY_ENTRY_LIMIT = 100;
/** The wire schema holds at most this many characters per term or alias. */
const DICTIONARY_TERM_LIMIT = 50;
const ALIAS_LIMIT = 8;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const emptyProvidersAtom = Atom.make(EMPTY_SERVER_PROVIDERS);
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const SHORTCUT_MODE_LABELS: Record<VoiceShortcutMode, string> = {
  auto: "Auto: press to toggle, hold to record",
  hold: "Hold: record while held",
  toggle: "Toggle: press to start, press again to stop",
};
const UNLOAD_LABELS: Record<SpeechModelUnloadTimeout, string> = {
  never: "Never",
  immediately: "Immediately",
  min_2: "After 2 minutes",
  min_5: "After 5 minutes",
  min_10: "After 10 minutes",
  min_15: "After 15 minutes",
  hour_1: "After 1 hour",
};
const normalizeTerm = (value: string) => value.replace(/\s+/g, " ").trim().normalize("NFC");
const spellingsOf = (words: SpeechCustomWords) =>
  new Set(
    words.flatMap(({ term, aliases }) =>
      [term, ...aliases].map((spelling) => spelling.toLocaleLowerCase()),
    ),
  );
const modelSortOrder = (model: EnvironmentSpeechModel) => {
  if (model.active) return 0;
  if (model.state === "installed") return 1;
  if (model.state === "downloading" || model.state === "verifying") return 2;
  return model.recommended ? 3 : 4;
};

/** Why a dictionary addition was refused, naming the limit, the current count and the request. */
function dictionaryRejection(
  label: string,
  words: SpeechCustomWords,
  terms: readonly string[],
): string | null {
  const requested = terms.length > 3 ? `${terms.slice(0, 3).join(", ")}…` : terms.join(", ");
  const tooLong = terms.find((term) => term.length > DICTIONARY_TERM_LIMIT);
  if (tooLong)
    return `Not added: "${tooLong.slice(0, DICTIONARY_TERM_LIMIT)}…" is ${tooLong.length} characters; a term holds at most ${DICTIONARY_TERM_LIMIT}.`;
  if (words.length + terms.length > DICTIONARY_ENTRY_LIMIT)
    return `Not added: "${requested}" would bring the ${label} to ${words.length + terms.length} entries; it holds at most ${DICTIONARY_ENTRY_LIMIT} and has ${words.length}.`;
  return null;
}

function ModelBadge(props: { icon: ReactNode; label: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} />}>
        {props.icon}
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

type ModelCardProps = {
  readonly model: EnvironmentSpeechModel;
  readonly comparisonLanguages: readonly string[];
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly testControls?: ReactNode;
  readonly children?: ReactNode;
};

function ModelCard(props: ModelCardProps) {
  const { model } = props;
  const downloading = model.state === "downloading" || model.state === "verifying";
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{model.name}</span>
          {model.recommended ? (
            <ModelBadge
              icon={<StarIcon />}
              label="Recommended"
              tooltip="A good default pick for the languages it covers."
            />
          ) : null}
          {model.supportsStreaming ? (
            <ModelBadge
              icon={<AudioLinesIcon />}
              label="Live preview"
              tooltip="Shows words in your draft as you speak, before the recording finishes."
            />
          ) : null}
          {model.supportsTranslation ? (
            <ModelBadge
              icon={<LanguagesIcon />}
              label="Translate"
              tooltip="Can write English text from speech in another language. Turn on Translate to English to use it."
            />
          ) : null}
        </span>
      }
      description={model.description || undefined}
      control={
        <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
          {props.testControls}
          {downloading ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Cancel ${model.name} download`}
              disabled={!props.canCancel}
              onClick={props.onCancel}
            >
              <XIcon />
            </Button>
          ) : model.state === "downloadable" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={props.busy}
                    onClick={props.onDownload}
                  />
                }
              >
                <DownloadIcon />
                Download
              </TooltipTrigger>
              <TooltipPopup side="top">
                {model.license ? `Licence: ${model.license}` : "Licence not stated"}
              </TooltipPopup>
            </Tooltip>
          ) : model.active ? (
            <Button size="sm" variant="secondary" disabled>
              <CheckIcon />
              Selected
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={props.busy} onClick={props.onSelect}>
              Use model
            </Button>
          )}
          {model.state === "installed" ? (
            <Button
              size="icon-sm"
              variant="ghost-destructive"
              disabled={props.busy}
              aria-label={`Delete ${model.name}`}
              onClick={props.onDelete}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
      }
    >
      <ModelBenchmarks
        model={model}
        languages={props.comparisonLanguages}
        facts={[
          ...(model.languages.length > 1
            ? [`${model.languages.length} languages`]
            : model.benchmark
              ? []
              : [languageLabel(model.languages[0] ?? "")]),
          formatSize(model.size),
        ]}
      />
      {downloading ? (
        <div className="pt-2">
          <VoiceModelDownloadProgress model={model} size={model.size} />
        </div>
      ) : null}
      <div className="pb-2">{props.children}</div>
    </SettingsRow>
  );
}

function DictionaryEditor(props: {
  readonly label: string;
  readonly words: SpeechCustomWords;
  readonly disabled?: boolean;
  readonly onChange: (words: SpeechCustomWords) => void;
}) {
  const { words, label, disabled = false, onChange } = props;
  const [termDraft, setTermDraft] = useState("");
  const [rejection, setRejection] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState<{ term: string; value: string } | null>(null);
  const spellings = spellingsOf(words);
  const seen = new Set(spellings);
  const newTerms = termDraft
    .split(/[,\n]/)
    .map(normalizeTerm)
    .filter((term) => {
      const key = term.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const addTerm = () => {
    if (disabled || newTerms.length === 0) return;
    const refused = dictionaryRejection(label, words, newTerms);
    setRejection(refused);
    if (refused) return;
    onChange([...words, ...newTerms.map((term) => ({ term, aliases: [] }))]);
    setTermDraft("");
  };
  const addAlias = () => {
    if (!aliasDraft) return;
    const value = normalizeTerm(aliasDraft.value);
    if (!value || value.length > DICTIONARY_TERM_LIMIT || spellings.has(value.toLocaleLowerCase()))
      return;
    onChange(
      words.map((entry) =>
        entry.term === aliasDraft.term && entry.aliases.length < ALIAS_LIMIT
          ? { term: entry.term, aliases: [...entry.aliases, value] }
          : entry,
      ),
    );
    setAliasDraft(null);
  };
  return (
    <>
      <div className="flex items-start gap-1.5">
        <Textarea
          value={termDraft}
          rows={1}
          maxLength={5_100}
          disabled={disabled}
          placeholder="Add words or phrases, separated by commas or line breaks"
          aria-label={`Add a word or phrase to the ${label}`}
          onChange={(event) => {
            setTermDraft(event.target.value);
            setRejection(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            addTerm();
          }}
        />
        <Button type="button" disabled={disabled || newTerms.length === 0} onClick={addTerm}>
          Add
        </Button>
      </div>
      {rejection ? (
        <Text as="p" variant="caption" tone="danger" role="alert" className="mt-1.5">
          {rejection}
        </Text>
      ) : null}
      {words.length > 0 ? (
        <ul aria-label={`${label} entries`} className="mt-3 flex flex-wrap gap-1.5">
          {words.map(({ term, aliases }) => (
            <Badge
              render={<li />}
              key={term}
              variant="secondary"
              size="control"
              className="gap-1 pr-0.5"
            >
              <Text as="span" variant="caption" weight="medium">
                {term}
              </Text>
              {aliases.length > 0 ? (
                <Text as="span" variant="caption" tone="muted">
                  ← {aliases.join(", ")}
                </Text>
              ) : null}
              {aliasDraft?.term === term ? (
                <Input
                  autoFocus
                  size="compact"
                  value={aliasDraft.value}
                  maxLength={DICTIONARY_TERM_LIMIT}
                  aria-label={`Alias for ${term}`}
                  placeholder="Misspelling"
                  className="w-32"
                  onChange={(event) => setAliasDraft({ term, value: event.target.value })}
                  onBlur={() => setAliasDraft(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setAliasDraft(null);
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addAlias();
                  }}
                />
              ) : (
                <Button
                  type="button"
                  size="micro"
                  variant="ghost-muted"
                  disabled={disabled || aliases.length >= ALIAS_LIMIT}
                  aria-label={`Add an alias for ${term}`}
                  onClick={() => setAliasDraft({ term, value: "" })}
                >
                  Alias
                </Button>
              )}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`Remove ${term}`}
                onClick={() => onChange(words.filter((entry) => entry.term !== term))}
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Vocabulary saved on the environment with the project, used by everyone who dictates there. */
function ProjectDictionaryRow() {
  const scope = useOptionalSettingsScope();
  const words = useScopedSettings((settings) => settings.speechProjectCustomWords);
  const updateScopedSettings = useUpdateScopedSettings();
  if (scope === null) return null;
  const isProjectScope = scope.scope.kind === "project" || scope.scope.kind === "checkout";
  const label = isProjectScope ? "project dictionary" : "shared dictionary";
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechProjectCustomWords"]}
      {...searchableSetting("speech-project-dictionary")}
      title={isProjectScope ? "Project dictionary" : "Shared dictionary"}
      description={
        isProjectScope
          ? "Saved with the project on its environment. Everyone who dictates in this project gets these spellings. They win over personal ones when the two overlap."
          : "Saved on the environment and used in every project there. Pick a project above to limit these words to one project."
      }
      control={
        <Text as="span" variant="caption" tone="muted" tabular>
          {words.length} {words.length === 1 ? "entry" : "entries"}
        </Text>
      }
    >
      <div className="pt-2 pb-3.5">
        <DictionaryEditor
          label={label}
          words={words}
          disabled={scope.connectedEnvironments.length === 0}
          onChange={(next) => updateScopedSettings({ speechProjectCustomWords: next })}
        />
      </div>
    </SettingsRow>
  );
}

/** Cleanup runs on the draft's environment, so its model is an environment setting there. */
function CleanupModelRow() {
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providers =
    useAtomValue(
      environment
        ? serverEnvironment.providersValueAtom(environment.environmentId)
        : emptyProvidersAtom,
    ) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const dedicated = settings.speechPostProcessingModelSelection !== null;
  const modelSelection =
    resolveSpeechPostProcessingModelSelection(settings, textGenerationProviders) ??
    settings.textGenerationModelSelection;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    modelSelection.instanceId,
    modelSelection.model,
  );
  const instanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === modelSelection.instanceId,
  );
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const provider: ProviderDriverKind = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const environmentLabel = environment?.label ?? "this environment";
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: "Cleanup model not saved", description: reason });
      return;
    }
    updateSettings({ speechPostProcessingModelSelection: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechPostProcessingModelSelection"]}
      {...searchableSetting("speech-post-processing-model")}
      title="Cleanup model"
      description={
        dedicated
          ? `Drafts on ${environmentLabel} use this model for cleanup instead of its text generation model.`
          : `Cleanup uses the text generation model on ${environmentLabel}. Pick another for a cheaper or faster one.`
      }
      resetAction={
        dedicated ? (
          <SettingResetButton
            label="cleanup model"
            tooltip="Follow the text generation model"
            onClick={() => updateSettings({ speechPostProcessingModelSelection: null })}
          />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 ? (
          <Text as="span" tone="muted">
            Connect an environment first.
          </Text>
        ) : !hasProvider || !instanceEntry ? (
          <Text as="span" tone="muted">
            No providers available.
          </Text>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={environment?.environmentId ?? null}
              activeInstanceId={modelSelection.instanceId}
              model={modelSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            <TraitsPicker
              provider={provider}
              models={instanceEntry.models}
              model={modelSelection.model}
              modelOptions={modelSelection.options}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                setModel(
                  createModelSelection(modelSelection.instanceId, modelSelection.model, options),
                )
              }
            />
          </div>
        )
      }
    />
  );
}

function useVoiceModels(prepared: PreparedConnection | null) {
  const canManage = useEnvironmentScope(prepared?.environmentId ?? null, AuthSettingsWriteScope);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [status, setStatus] = useState<EnvironmentSpeechStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [actionConnection, setActionConnection] = useState(prepared);
  if (actionConnection !== prepared) {
    setActionConnection(prepared);
    setBusy(false);
    setRequestedDownload(null);
    setModels([]);
    setStatus(null);
  }
  const epoch = useRef(0);
  const refreshRevision = useRef(0);
  const refresh = useStableCallback(
    async (connection: PreparedConnection, mode: "foreground" | "progress") => {
      const current = epoch.current;
      const revision = ++refreshRevision.current;
      try {
        const [nextStatus, nextModels] = await Promise.all([
          runtime.runPromise(getEnvironmentSpeechStatus(connection)),
          runtime.runPromise(getEnvironmentSpeechModels(connection, mode === "foreground")),
        ]);
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        setStatus(nextStatus);
        setModels((previous) => {
          if (mode === "foreground") return nextModels.models;
          const benchmarks = new Map(previous.map((model) => [model.id, model.benchmark]));
          return nextModels.models.map((model) => {
            const benchmark = benchmarks.get(model.id);
            return benchmark ? { ...model, benchmark } : model;
          });
        });
      } catch (error) {
        if (mode === "progress") return;
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        toastManager.add({
          type: "error",
          title: "Could not load transcription models",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Load the environment's model catalog when its connection becomes available.
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared, "foreground");
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading =
    requestedDownload !== null ||
    models.some((model) => model.state === "downloading" || model.state === "verifying");
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Poll progress while a local request or the environment reports an active download.
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared, "progress");
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloading, prepared, refresh]);

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      if (current === epoch.current)
        toastManager.add({
          type: "error",
          title: label,
          description: error instanceof Error ? error.message : String(error),
        });
    }
    if (current === epoch.current) {
      if (downloadId) setRequestedDownload(null);
      else setBusy(false);
      await refresh(prepared, "foreground");
    }
  };
  return {
    models,
    status,
    run,
    controlsDisabled: busy || downloading || !canManage,
    canCancel: canManage && !busy,
    requestedDownload,
  };
}

type VoiceModels = ReturnType<typeof useVoiceModels>;

function AdvancedSpeechSettings({
  prepared,
  catalog,
}: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
}) {
  const { run, controlsDisabled, status } = catalog;
  if (!status?.supported) return null;
  const { acceleration, gpuDevices, modelUnloadTimeout } = status;
  const selectedGpu = acceleration.startsWith("gpu:")
    ? gpuDevices.find((device) => `gpu:${device.id}` === acceleration)
    : undefined;
  return (
    <AdvancedSettings targetIds={[searchableSetting("speech-hardware").id]}>
      <SettingsRow
        {...searchableSetting("speech-hardware")}
        title="Hardware"
        description="Auto uses the environment's GPU when it has one."
        control={
          <Select
            value={acceleration}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run("Could not change transcription hardware", () =>
                  runtime.runPromise(
                    updateEnvironmentSpeechAcceleration(prepared, value as SpeechAcceleration),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label="Transcription hardware" className="max-w-72">
              <SelectValue>
                {acceleration === "auto"
                  ? "Auto"
                  : acceleration === "cpu"
                    ? "CPU"
                    : (selectedGpu?.name ?? "Selected GPU (Unavailable)")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="cpu">CPU</SelectItem>
              {acceleration.startsWith("gpu:") && !selectedGpu ? (
                <SelectItem value={acceleration}>Selected GPU (Unavailable)</SelectItem>
              ) : null}
              {gpuDevices.map((device) => (
                <SelectItem key={device.id} value={`gpu:${device.id}`}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Unload model"
        description="Release the model's memory on the environment after it sits idle."
        control={
          <Select
            value={modelUnloadTimeout}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run("Could not change when the model unloads", () =>
                  runtime.runPromise(
                    updateEnvironmentSpeechModelUnloadTimeout(
                      prepared,
                      value as SpeechModelUnloadTimeout,
                    ),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label="Unload model" className="max-w-72">
              <SelectValue>{UNLOAD_LABELS[modelUnloadTimeout]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(UNLOAD_LABELS) as SpeechModelUnloadTimeout[]).map((timeout) => (
                <SelectItem key={timeout} value={timeout}>
                  {UNLOAD_LABELS[timeout]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </AdvancedSettings>
  );
}

function SpeechModelBrowser(props: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
  testEnvironmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectName: string | null;
}) {
  const {
    prepared,
    catalog: { status, models, run, controlsDisabled, canCancel, requestedDownload },
  } = props;
  const [search, setSearch] = useState("");
  const [languageSearch, setLanguageSearch] = useState("");
  const [selection, setSelection] = useState<string[] | null>(null);
  const preferred = navigator.languages.map((language) => language.toLowerCase().split("-")[0]!);
  const supportedLanguages = [...new Set(models.flatMap((model) => model.languages))];
  const defaultLanguage = preferred.find((code) => supportedLanguages.includes(code));
  const selectedLanguages = selection ?? (defaultLanguage ? [defaultLanguage] : []);
  const languages = orderSpeechLanguages(supportedLanguages, preferred);
  const needle = languageSearch.trim().toLocaleLowerCase();
  const visibleLanguages = languages.filter(
    (code) =>
      !needle || code.includes(needle) || languageLabel(code).toLocaleLowerCase().includes(needle),
  );
  const query = search.trim().toLocaleLowerCase();
  const sortedModels = models
    .filter(
      (model) =>
        selectedLanguages.every((language) => model.languages.includes(language)) &&
        (!query || (model.name + " " + model.description).toLocaleLowerCase().includes(query)),
    )
    .toSorted((left, right) => modelSortOrder(left) - modelSortOrder(right));
  const activeModel = models.find((model) => model.active);
  const renderedModels =
    activeModel && !sortedModels.includes(activeModel)
      ? [activeModel, ...sortedModels]
      : sortedModels;
  const unavailableModelId =
    status?.supported === true ? (status.unavailableModelId ?? null) : null;

  return (
    <SettingsSearchTarget
      {...searchableSetting("speech-models")}
      className="@container/voice-models"
    >
      {status && !status.supported ? (
        <Text as="p" tone="muted" className="mx-3.5 my-2.5">
          This environment can't transcribe audio: {status.reason}.
        </Text>
      ) : null}
      {status?.supported ? (
        <>
          {unavailableModelId ? (
            <Text as="p" variant="callout" tone="warning" role="status" className="mx-3.5 my-2.5">
              The selected model {unavailableModelId} is no longer available. This environment is
              using {status.model}, its default, instead.
            </Text>
          ) : null}
          <Text as="p" variant="caption" tone="muted" className="mx-3.5 my-2.5">
            Pick languages to see models that support all of them. Accuracy is the word or character
            error rate, so lower is better. Speed is the time to transcribe 30 seconds of audio on a
            reference GPU.
          </Text>
          <Separator />
          <div className="@min-[32rem]/voice-models:grid @min-[32rem]/voice-models:grid-cols-[11rem_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col">
              <div className="space-y-2 p-3">
                <Text as="p" weight="medium">
                  Languages
                </Text>
                <Input
                  size="compact"
                  aria-label="Search languages"
                  placeholder="Search languages…"
                  value={languageSearch}
                  onChange={(event) => setLanguageSearch(event.target.value)}
                />
              </div>
              <div
                role="group"
                aria-label="Browse models by language"
                className="flex gap-1 overflow-x-auto px-2 pb-2 @min-[32rem]/voice-models:h-72 @min-[32rem]/voice-models:flex-col @min-[32rem]/voice-models:overflow-y-auto"
              >
                <LanguageRow
                  label="All languages"
                  selected={selectedLanguages.length === 0}
                  onClick={() => setSelection([])}
                />
                {visibleLanguages.map((code) => (
                  <LanguageRow
                    key={code}
                    label={languageLabel(code)}
                    selected={selectedLanguages.includes(code)}
                    onClick={() =>
                      setSelection(
                        selectedLanguages.includes(code)
                          ? selectedLanguages.filter((language) => language !== code)
                          : [...selectedLanguages, code],
                      )
                    }
                  />
                ))}
                {visibleLanguages.length === 0 ? (
                  <Text as="p" variant="caption" tone="muted" className="mx-2 my-1">
                    No languages match.
                  </Text>
                ) : null}
              </div>
            </div>
            <div className="flex min-w-0 flex-col">
              <div className="space-y-2 p-3">
                <Text as="p" weight="medium">
                  {selectedLanguages.length
                    ? "Models for " + selectedLanguages.map(languageLabel).join(", ")
                    : "All models"}
                </Text>
                <Input
                  size="compact"
                  aria-label="Search transcription models"
                  placeholder="Search models…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div
                className="h-72 overflow-y-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&>*+*]:border-t [&>*+*]:border-border"
                role="region"
                aria-label="Transcription models"
                tabIndex={0}
              >
                {sortedModels.length === 0 ? (
                  <Text as="p" tone="muted" className="mx-3.5 my-2.5">
                    No models match.
                  </Text>
                ) : null}
                {renderedModels.map((model) => {
                  const card: ModelCardProps = {
                    model:
                      model.id === requestedDownload && model.state === "downloadable"
                        ? { ...model, state: "downloading" }
                        : model,
                    busy: controlsDisabled,
                    canCancel,
                    comparisonLanguages: selectedLanguages,
                    onDownload: () =>
                      void run(
                        "Could not download the model",
                        async () => {
                          const result = await runtime.runPromise(
                            downloadEnvironmentSpeechModel(prepared, model.id),
                          );
                          const installed = result.models.some(
                            (candidate) =>
                              candidate.id === model.id && candidate.state === "installed",
                          );
                          if (installed)
                            await runtime.runPromise(
                              selectEnvironmentSpeechModel(prepared, model.id),
                            );
                        },
                        model.id,
                      ),
                    onSelect: () =>
                      void run("Could not select the model", () =>
                        runtime.runPromise(selectEnvironmentSpeechModel(prepared, model.id)),
                      ),
                    onCancel: () =>
                      void run("Could not cancel the download", () =>
                        runtime.runPromise(
                          cancelEnvironmentSpeechModelDownload(prepared, model.id),
                        ),
                      ),
                    onDelete: () =>
                      void ensureLocalApi()
                        .dialogs.confirm(`Delete ${model.name} from this environment?`)
                        .then((confirmed) => {
                          if (confirmed)
                            return run("Could not delete the model", () =>
                              runtime.runPromise(removeEnvironmentSpeechModel(prepared, model.id)),
                            );
                        }),
                  };
                  return model.active ? (
                    <TranscriptionTest
                      key={model.id}
                      card={card}
                      hidden={!sortedModels.includes(model)}
                      environmentId={props.testEnvironmentId}
                      projectId={props.projectId}
                      projectName={props.projectName}
                    />
                  ) : (
                    <ModelCard key={model.id} {...card} />
                  );
                })}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </SettingsSearchTarget>
  );
}

function TranscriptionTest(props: {
  readonly card: ModelCardProps;
  readonly hidden: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
}) {
  const [transcript, setTranscript] = useState<string | null>(null);
  const draft = transcript ?? "";
  const [showTranscript, setShowTranscript] = useState(false);
  const draftRef = useRef(draft);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Publish the committed draft to the asynchronous transcription controller.
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const speech = useEnvironmentSpeechInput({
    environmentId: props.environmentId,
    projectId: props.projectId,
    projectName: props.projectName,
    ownerKey: JSON.stringify([props.environmentId, props.projectId]),
    draftText: draft,
    cleanup: false,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    commitDraft: (text) => setTranscript(text),
  });
  const idle = speech.state.phase === "idle";
  return (
    <SettingsSearchTarget {...searchableSetting("transcription-test")} hidden={props.hidden}>
      <ModelCard
        {...props.card}
        testControls={
          speech.available ? (
            idle ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setShowTranscript(true);
                  void speech.start();
                }}
              >
                <MicIcon />
                Test model
              </Button>
            ) : speech.state.phase === "recording" ? (
              <Button size="sm" variant="secondary" onClick={() => void speech.stop()}>
                <CheckIcon />
                Stop
              </Button>
            ) : null
          ) : (
            <Text as="span" variant="caption" tone="muted">
              {speech.status?.supported === false
                ? speech.status.reason
                : "Waiting for the environment to connect"}
            </Text>
          )
        }
      >
        <ComposerSpeechTray
          state={speech.state}
          progress={null}
          level={speech.level}
          preview={speech.preview}
          onCancel={() => speech.cancel()}
          onSkipPostProcessing={() => speech.skipPostProcessing()}
        />
        {showTranscript && idle ? (
          <div className="flex items-start gap-2 pt-1">
            <div className="min-w-0 flex-1">
              <Text as="p" variant="caption" tone="muted">
                Say a sentence in the language above. Cleanup is skipped, so you see exactly what
                the model heard. The transcript stays on this page.
              </Text>
              {transcript !== null ? (
                <Text
                  as="p"
                  role="status"
                  aria-label="Test transcript"
                  preserve
                  breakWords
                  className="mt-2"
                >
                  {transcript || "No speech recognized. Try again."}
                </Text>
              ) : null}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close model test"
              onClick={() => {
                speech.cancel();
                setShowTranscript(false);
              }}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </ModelCard>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        downloading={speech.setup.downloading}
        cancelled={speech.setup.cancelled}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </SettingsSearchTarget>
  );
}

export function VoiceSettingsPanel() {
  const cleanupEnabled = useCleanupGrant() !== null;
  const settings = useClientSettings();
  const settingsScope = useOptionalSettingsScope();
  const destination = useVoiceTranscriptionDestination();
  const { environments } = useEnvironments();
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const prepared = destination.prepared;
  const catalog = useVoiceModels(prepared);

  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setMicrophones(await listBrowserMicrophones());
    } catch {
      setMicrophones([]);
    }
  });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Subscribe to microphone device changes while settings are open.
  useEffect(() => {
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshMicrophones]);
  const modelStatus = catalog.status;
  const target = settingsScope?.target;
  const members = settingsScope?.scope.members;
  const project =
    members?.find(
      (member) => member.environmentId === target?.environmentId && member.id === target.projectId,
    ) ?? members?.[0];

  const selectedMicrophone = settings.voiceMicrophone;
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      "Selected microphone (unavailable)")
    : "System default";
  const destinationValue = destination.environmentId ?? OFF;
  const chosenEnvironment = environments.find(
    (environment) => environment.environmentId === destination.environmentId,
  );
  const chosenUnsupported =
    chosenEnvironment?.serverConfig != null &&
    chosenEnvironment.serverConfig.environment.capabilities.voiceTranscription !== true;
  const model = prepared && modelStatus?.supported ? modelStatus : null;
  const customWords = settings.speechCustomWords;
  const promptMode = settings.speechPostProcessingPrompt.mode;

  return (
    <SettingsPageContainer
      searchTargetFallbacks={{
        "transcription-environment": "voice-transcription-destination",
        "local-voice-input": prepared ? "speech-models" : "voice-transcription-destination",
        "speech-models": prepared ? undefined : "voice-transcription-destination",
        "speech-hardware": prepared && model ? undefined : "voice-transcription-destination",
        "transcription-test": !prepared
          ? "voice-transcription-destination"
          : !model || model.state === "missing-model"
            ? "speech-models"
            : undefined,
        "speech-post-processing-model":
          cleanupEnabled && settingsScope ? undefined : "speech-post-processing",
        "speech-correction-word": cleanupEnabled ? undefined : "speech-post-processing",
      }}
    >
      <SettingsSection id="voice-input" title="Input">
        <SettingsRow
          {...searchableSetting("voice-transcription-destination")}
          title="Send microphone audio to"
          description="Audio is sent to this environment to be transcribed, then discarded. Off turns voice input off on this device. The choice is saved on this device only."
          control={
            <Select
              value={destinationValue}
              onValueChange={(value) => {
                if (!value) return;
                chooseAudioDestination(
                  value === OFF
                    ? null
                    : { kind: "environment", environmentId: value as EnvironmentId },
                );
              }}
            >
              <SelectTrigger size="sm" aria-label="Send microphone audio to" className="max-w-72">
                <SelectValue>
                  {destinationValue === OFF
                    ? "Off"
                    : (chosenEnvironment?.label ?? "Chosen environment (unavailable)")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={OFF}>Off</SelectItem>
                {environments.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
                {destination.environmentId && !chosenEnvironment ? (
                  <SelectItem value={destination.environmentId}>
                    Chosen environment (unavailable)
                  </SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
          }
        >
          {destination.refusal ? (
            <Text as="p" variant="caption" tone="danger" role="alert" className="mt-2">
              {destination.refusal}
            </Text>
          ) : destination.environmentId && chosenUnsupported ? (
            <Text as="p" variant="caption" tone="danger" className="mt-2">
              {chosenEnvironment?.label} can't transcribe audio. Pick an environment that can to use
              voice input.
            </Text>
          ) : null}
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("voice-microphone")}
          title="Microphone"
          description="System default follows your operating system. The test records ten seconds and plays them back here. It stays on this device and is never transcribed."
          control={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <SettingsSearchTarget {...searchableSetting("microphone-test")}>
                <MicrophoneTest key={selectedMicrophone} microphoneId={selectedMicrophone} />
              </SettingsSearchTarget>
              <div className="flex min-w-0 items-center gap-1.5">
                <Select
                  value={selectedMicrophone ? `device:${selectedMicrophone}` : SYSTEM_DEFAULT}
                  onValueChange={(value) => {
                    if (value)
                      void updateClientSettings({
                        voiceMicrophone:
                          value === SYSTEM_DEFAULT ? "" : value.slice("device:".length),
                      });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Microphone" className="max-w-64">
                    <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
                    {selectedMicrophone &&
                    !microphones.some((device) => device.deviceId === selectedMicrophone) ? (
                      <SelectItem value={`device:${selectedMicrophone}`}>
                        Selected microphone (unavailable)
                      </SelectItem>
                    ) : null}
                    {microphones.map((device) => (
                      <SelectItem key={device.deviceId} value={`device:${device.deviceId}`}>
                        {device.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh microphones"
                  onClick={() => void refreshMicrophones()}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("dictation-shortcut-mode")}
          title="Dictation shortcut"
          description="How the dictation shortcut starts and stops recording. Set the key in Keybindings."
          control={
            <Select
              value={settings.voiceShortcutMode}
              onValueChange={(value) => {
                if (value)
                  void updateClientSettings({ voiceShortcutMode: value as VoiceShortcutMode });
              }}
            >
              <SelectTrigger size="sm" aria-label="Dictation shortcut mode" className="max-w-72">
                <SelectValue>{SHORTCUT_MODE_LABELS[settings.voiceShortcutMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(SHORTCUT_MODE_LABELS) as VoiceShortcutMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {SHORTCUT_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="voice-transcription" title="Transcription">
        <SettingsRow
          {...searchableSetting("speech-language")}
          title="Language"
          description={
            model
              ? `${model.model} ${model.supportsLanguageDetection ? "detects the language automatically" : "uses one fixed language"}.`
              : "Choose an environment above to see the languages its transcription model supports."
          }
          control={<SpeechLanguageSelect model={model} />}
        />
        {model?.supportsTranslation ? (
          <SettingsRow
            title="Translate to English"
            description="Speak any language and get English text."
            control={
              <Switch
                aria-label="Translate to English"
                checked={settings.speechTranslateToEnglish}
                onCheckedChange={(checked) =>
                  void updateClientSettings({ speechTranslateToEnglish: checked })
                }
              />
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("speech-silence-filtering")}
          title="Silence filtering"
          description="Skip silence and other non-speech audio before transcription, keeping a short buffer so words aren't cut off."
          control={
            <Switch
              aria-label="Silence filtering"
              checked={settings.speechSilenceFiltering}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechSilenceFiltering: checked })
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("remove-filler-words")}
          title="Remove filler words"
          description="Leave out hesitation words like um and uh."
          control={
            <Switch
              aria-label="Remove filler words"
              checked={settings.speechRemoveFillerWords}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechRemoveFillerWords: checked })
              }
            />
          }
        />
        {prepared ? (
          <SpeechModelBrowser
            key={prepared.environmentId}
            prepared={prepared}
            catalog={catalog}
            testEnvironmentId={
              project?.environmentId ?? target?.environmentId ?? prepared.environmentId
            }
            projectId={project?.id ?? null}
            projectName={project?.title ?? null}
          />
        ) : null}
        {prepared ? <AdvancedSpeechSettings prepared={prepared} catalog={catalog} /> : null}
      </SettingsSection>

      <SettingsSection id="voice-dictionary" title="Dictionary">
        <SettingsRow
          {...searchableSetting("speech-dictionary")}
          title="Dictionary"
          description="Names and terms to spell your way, saved on this device. Add an alias when a term keeps being misheard. The name of the project you dictate in is also sent as a hint."
          control={
            <Text as="span" variant="caption" tone="muted" tabular>
              {customWords.length} {customWords.length === 1 ? "entry" : "entries"}
            </Text>
          }
        >
          <div className="pt-2 pb-3.5">
            <DictionaryEditor
              label="dictionary"
              words={customWords}
              onChange={(words) => void updateClientSettings({ speechCustomWords: words })}
            />
          </div>
        </SettingsRow>
        <ProjectDictionaryRow />
      </SettingsSection>

      <SettingsSection id={searchableSetting("speech-post-processing").id} title="Cleanup">
        <SettingsRow
          title="Clean up transcripts with a provider"
          description="Sends each transcript and the draft text around your cursor to the draft environment's text generation provider to fix punctuation, numbers, and spoken corrections. Your audio is never sent."
          control={
            <Switch
              aria-label="Clean up transcripts with a provider"
              checked={cleanupEnabled}
              onCheckedChange={chooseTranscriptCleanup}
            />
          }
        />
        {cleanupEnabled ? (
          <SettingsRow
            title="Cleanup instructions"
            description="Use the built-in instructions or write your own."
            control={
              <Select
                value={promptMode}
                onValueChange={(value) => {
                  if (value === "default" || value === "custom")
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        ...settings.speechPostProcessingPrompt,
                        mode: value,
                      },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Cleanup instructions" className="max-w-64">
                  <SelectValue>{promptMode === "custom" ? "Custom" : "Built-in"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">Built-in</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectPopup>
              </Select>
            }
          >
            <div className="pt-2 pb-3.5">
              <Textarea
                aria-label="Custom cleanup instructions"
                maxLength={10_000}
                disabled={promptMode !== "custom"}
                value={
                  promptMode === "custom"
                    ? settings.speechPostProcessingPrompt.customInstructions
                    : DEFAULT_SPEECH_POST_PROCESSING_PROMPT
                }
                onChange={(event) =>
                  void updateClientSettings({
                    speechPostProcessingPrompt: {
                      mode: "custom",
                      customInstructions: event.target.value,
                    },
                  })
                }
              />
            </div>
          </SettingsRow>
        ) : null}
        {cleanupEnabled && settingsScope !== null ? <CleanupModelRow /> : null}
        {cleanupEnabled ? (
          <SettingsRow
            {...searchableSetting("speech-correction-word")}
            title="Correction cue"
            description="The word or phrase you say to flag a correction, like sorry or scratch that. Cleanup applies a correction only where one is meant."
            control={
              <Input
                key={settings.speechCorrectionWord}
                defaultValue={settings.speechCorrectionWord}
                maxLength={50}
                placeholder="sorry"
                aria-label="Correction cue"
                className="w-40"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next !== settings.speechCorrectionWord)
                    void updateClientSettings({ speechCorrectionWord: next });
                }}
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
