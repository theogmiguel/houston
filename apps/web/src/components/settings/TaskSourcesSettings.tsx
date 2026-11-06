import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import type {
  HoustonTaskSourceSettings,
  HoustonTaskSourceSettingsInput,
  HoustonTaskSourceStatusMapping,
  HoustonTaskSourceImportStatus,
} from "@houston-app/contracts/houston/taskSources";
import type {
  HoustonSlackImportStatus,
  HoustonSlackInfo,
  HoustonSlackLanguage,
} from "@houston-app/contracts/houston/slack";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HashIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/reactivity";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { requestConfirmDialog } from "~/confirmDialog";
import { environmentProjects } from "~/state/projects";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { slackEnvironment } from "~/state/slack";
import { taskSourcesEnvironment } from "~/state/taskSources";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "../ui/empty";
import { Glyph } from "../ui/glyph";
import { Input } from "../ui/input";
import { Separator } from "../ui/separator";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { RelativeTime } from "../RelativeTime";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  blankToNull,
  joinStatusValues,
  parseStatusValues,
  slackConnectionState,
  taskSourceProviderLabel,
  taskSourceState,
} from "../tasks/taskSources.logic";

const SLACK_MANIFEST = {
  display_information: { name: "Houston" },
  features: { bot_user: { display_name: "Houston", always_online: true } },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "chat:write",
        "files:read",
        "reactions:read",
        "reactions:write",
        "users:read",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ["app_mention", "message.channels", "message.groups", "reaction_added"],
    },
    interactivity: { is_enabled: false },
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

// A new channel row needs a stable key before it has a channel id.
let channelDraftSequence = 0;
const nextChannelKey = () => `draft-${++channelDraftSequence}`;

const SLACK_LANGUAGES: ReadonlyArray<{ value: HoustonSlackLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "pt-BR", label: "Português (Brasil)" },
];

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The task source request failed.";
}

function copyManifest(): void {
  void writeTextToClipboard(JSON.stringify(SLACK_MANIFEST, null, 2), "Slack manifest")
    .then(() => toastManager.add({ type: "success", title: "Slack manifest copied" }))
    .catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Manifest not copied",
        description: readableFailure(error),
      });
    });
}

function stateBadge(state: { label: string; tone: "success" | "error" | "default" }) {
  if (state.tone === "success") return <Badge variant="success">{state.label}</Badge>;
  if (state.tone === "error") return <Badge variant="error">{state.label}</Badge>;
  return <Badge>{state.label}</Badge>;
}

function SlackTokenFields({
  environmentId,
  onConnected,
}: {
  environmentId: EnvironmentId;
  onConnected: () => void;
}) {
  const connect = useAtomCommand(slackEnvironment.connect);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState(false);
  const canConnect = appToken.trim().length > 0 && botToken.trim().length > 0;
  const submit = async () => {
    if (!canConnect || busy) return;
    setBusy(true);
    const outcome = await connect({
      environmentId,
      input: {
        appToken: Redacted.make(appToken.trim()),
        botToken: Redacted.make(botToken.trim()),
      },
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Slack not connected",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      return;
    }
    setAppToken("");
    setBotToken("");
    onConnected();
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3.5 py-3">
      <label className="grid gap-1">
        <Text variant="caption" tone="muted">
          App-level token (starts with xapp-)
        </Text>
        <Input
          type="password"
          autoComplete="off"
          value={appToken}
          placeholder="xapp-…"
          onChange={(event) => setAppToken(event.currentTarget.value)}
        />
      </label>
      <label className="grid gap-1">
        <Text variant="caption" tone="muted">
          Bot token (starts with xoxb-)
        </Text>
        <Input
          type="password"
          autoComplete="off"
          value={botToken}
          placeholder="xoxb-…"
          onChange={(event) => setBotToken(event.currentTarget.value)}
        />
      </label>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 pt-1">
        <Text variant="caption" tone="muted">
          Both tokens are stored as secrets on the server.
        </Text>
        <Button size="sm" disabled={!canConnect || busy} onClick={() => void submit()}>
          Connect
        </Button>
      </div>
    </div>
  );
}

function SlackFirstRun({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <SettingsSection id="task-sources-slack" title="Slack">
      <SettingsGroup>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 px-3.5 py-3">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <Glyph icon={HashIcon} className="mt-0.5 size-4" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Text as="h3" variant="headline" weight="medium">
                Slack app
              </Text>
              <Text variant="caption" tone="muted">
                Create it from a manifest with Socket Mode on, install it, then paste both tokens.
              </Text>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={copyManifest}>
              Copy manifest
            </Button>
            <Button size="sm" variant="outline" onClick={() => void openSlackApi()}>
              <ExternalLinkIcon aria-hidden />
              api.slack.com
            </Button>
          </div>
        </div>
        <SlackTokenFields environmentId={environmentId} onConnected={() => undefined} />
      </SettingsGroup>
    </SettingsSection>
  );
}

async function openSlackApi(): Promise<void> {
  const { readLocalApi } = await import("~/localApi");
  const api = readLocalApi();
  if (api == null) window.open("https://api.slack.com/apps", "_blank", "noreferrer");
  else await api.shell.openExternal("https://api.slack.com/apps");
}

interface ChannelDraft {
  readonly key: string;
  readonly channelId: string;
  readonly projectId: string;
}

function SlackConfigured({
  environmentId,
  info,
  projects,
}: {
  environmentId: EnvironmentId;
  info: HoustonSlackInfo;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const configure = useAtomCommand(slackEnvironment.configure);
  const disconnect = useAtomCommand(slackEnvironment.disconnect);
  const [owner, setOwner] = useState(info.ownerUserId ?? "");
  const [language, setLanguage] = useState<HoustonSlackLanguage>(info.language);
  const [channels, setChannels] = useState<ReadonlyArray<ChannelDraft>>(
    info.channels.map((channel) => ({
      key: channel.channelId,
      channelId: channel.channelId,
      projectId: channel.projectId,
    })),
  );
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const state = slackConnectionState(info);

  const save = async () => {
    if (busy !== null) return;
    setBusy("save");
    const outcome = await configure({
      environmentId,
      input: {
        expectedRevision: info.revision,
        ownerUserId: owner.trim().length === 0 ? null : owner.trim(),
        channels: channels.map((channel) => ({
          channelId: channel.channelId.trim(),
          projectId: channel.projectId as ProjectId,
        })),
        language,
      },
    });
    setBusy(null);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Slack settings not saved",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  const runDisconnect = async () => {
    const confirmed = await requestConfirmDialog(
      "Disconnect Slack? Houston stops reading its mapped channels and removes both tokens.",
    );
    if (confirmed !== true) return;
    setBusy("disconnect");
    const outcome = await disconnect({ environmentId, input: {} });
    setBusy(null);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Slack not disconnected",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  const addChannel = () => {
    const firstProject = projects[0];
    if (firstProject === undefined) return;
    setChannels((current) => [
      ...current,
      { key: nextChannelKey(), channelId: "", projectId: firstProject.id },
    ]);
  };

  return (
    <SettingsSection id="task-sources-slack" title="Slack" headerAction={stateBadge(state)}>
      <SettingsGroup>
        <SettingsRow
          title="Connection"
          description={info.team === null ? "Connected" : `Connected to ${info.team}`}
          status={
            info.lastEventAt === null ? null : (
              <>
                Last event <RelativeTime timestamp={info.lastEventAt} />
              </>
            )
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void runDisconnect()}
            >
              Disconnect
            </Button>
          }
        />
        <SettingsRow
          title="Tokens"
          description="App token and bot token, stored as secrets on the server."
          control={
            <Button size="sm" variant="outline" onClick={() => setReplacing((value) => !value)}>
              {replacing ? "Cancel" : "Replace…"}
            </Button>
          }
        >
          {replacing ? (
            <div>
              <Separator />
              <SlackTokenFields
                environmentId={environmentId}
                onConnected={() => setReplacing(false)}
              />
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Owner"
          description="The Slack member ID whose ✅ starts a request."
          control={
            <Input
              font="mono"
              className="w-44"
              value={owner}
              placeholder="U…"
              aria-label="Slack owner member ID"
              onChange={(event) => setOwner(event.currentTarget.value)}
            />
          }
        />
        <div className="flex min-w-0 flex-col gap-2 px-3.5 py-3">
          <div className="flex min-w-0 items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Text variant="headline" weight="medium">
                Channels
              </Text>
              <Text variant="caption" tone="muted">
                Each channel files into one project. Up to 16.
              </Text>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={channels.length >= 16}
              onClick={addChannel}
            >
              <PlusIcon aria-hidden />
              Add channel
            </Button>
          </div>
          {channels.length === 0 ? (
            <Text variant="caption" tone="muted">
              No channel is mapped, so no mention files a task.
            </Text>
          ) : (
            <div className="flex min-w-0 flex-col gap-1.5">
              {channels.map((channel, index) => (
                <div key={channel.key} className="flex min-w-0 items-center gap-1.5">
                  <Input
                    font="mono"
                    className="min-w-0 flex-1"
                    value={channel.channelId}
                    placeholder="C…"
                    aria-label={`Channel ${index + 1}`}
                    onChange={(event) =>
                      setChannels((current) =>
                        current.map((entry, entryIndex) =>
                          entryIndex === index
                            ? { ...entry, channelId: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <div className="w-44 shrink-0">
                    <Select
                      value={channel.projectId}
                      onValueChange={(value) => {
                        if (typeof value !== "string") return;
                        setChannels((current) =>
                          current.map((entry, entryIndex) =>
                            entryIndex === index ? { ...entry, projectId: value } : entry,
                          ),
                        );
                      }}
                    >
                      <SelectTrigger aria-label={`Project for channel ${index + 1}`}>
                        <SelectValue>
                          {projects.find((project) => project.id === channel.projectId)?.title ??
                            "Choose a project"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`Remove channel ${index + 1}`}
                    onClick={() =>
                      setChannels((current) =>
                        current.filter((_, entryIndex) => entryIndex !== index),
                      )
                    }
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <SettingsRow
          title="Language"
          description="Used for Houston's own Slack text and the agent's hand-back."
          control={
            <div className="w-44">
              <Select
                value={language}
                onValueChange={(value) => {
                  if (value === "en" || value === "pt-BR") setLanguage(value);
                }}
              >
                <SelectTrigger aria-label="Slack language">
                  <SelectValue>
                    {SLACK_LANGUAGES.find((option) => option.value === language)?.label ??
                      "English"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {SLACK_LANGUAGES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
      </SettingsGroup>
      <div className="flex justify-end">
        <Button size="sm" disabled={busy !== null} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </SettingsSection>
  );
}

function SlackSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const infoResult = useAtomValue(slackEnvironment.info({ environmentId, input: {} }));
  const projects = useAtomValue(environmentProjects.projectsAtom)
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id as string, title: project.title }));
  if (AsyncResult.isInitial(infoResult) && !AsyncResult.isSuccess(infoResult)) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (AsyncResult.isFailure(infoResult)) {
    return (
      <Alert variant="error">
        <AlertDescription>{readableFailure(squashAtomCommandFailure(infoResult))}</AlertDescription>
      </Alert>
    );
  }
  const info = infoResult.value;
  return info.enabled ? (
    <SlackConfigured environmentId={environmentId} info={info} projects={projects} />
  ) : (
    <SlackFirstRun environmentId={environmentId} />
  );
}

interface ProviderForm {
  readonly repository: string;
  readonly label: string;
  readonly assignedUser: string;
  readonly dataSourceId: string;
  readonly assigneeUserId: string;
  readonly activeStatuses: string;
  readonly titlePropertyId: string;
  readonly descriptionPropertyId: string;
  readonly statusPropertyId: string;
  readonly assigneePropertyId: string;
  readonly projectRelationPropertyId: string;
  readonly projectsDataSourceId: string;
  readonly projectTitlePropertyId: string;
  readonly projectDescriptionPropertyId: string;
  readonly prUrlPropertyId: string;
  readonly statusMapping: HoustonTaskSourceStatusMapping;
}

function formOf(settings: HoustonTaskSourceSettings): ProviderForm {
  return {
    repository: settings.githubRepository ?? "",
    label: settings.githubLabel ?? "",
    assignedUser: settings.githubAssignedUser ?? "",
    dataSourceId: settings.notionDataSourceId ?? "",
    assigneeUserId: settings.notionAssigneeUserId ?? "",
    activeStatuses: joinStatusValues(settings.notionActiveStatusValues),
    titlePropertyId: settings.notionTitlePropertyId ?? "",
    descriptionPropertyId: settings.notionDescriptionPropertyId ?? "",
    statusPropertyId: settings.notionStatusPropertyId ?? "",
    assigneePropertyId: settings.notionAssigneePropertyId ?? "",
    projectRelationPropertyId: settings.notionProjectRelationPropertyId ?? "",
    projectsDataSourceId: settings.notionProjectsDataSourceId ?? "",
    projectTitlePropertyId: settings.notionProjectTitlePropertyId ?? "",
    projectDescriptionPropertyId: settings.notionProjectDescriptionPropertyId ?? "",
    prUrlPropertyId: settings.notionPrUrlPropertyId ?? "",
    statusMapping: settings.notionStatusMapping,
  };
}

function ProviderCard({
  environmentId,
  settings,
  projectId,
}: {
  environmentId: EnvironmentId;
  settings: HoustonTaskSourceSettings;
  projectId: ProjectId;
}) {
  const saveSettings = useAtomCommand(taskSourcesEnvironment.saveSettings);
  const setCredential = useAtomCommand(taskSourcesEnvironment.setCredential);
  const clearCredential = useAtomCommand(taskSourcesEnvironment.clearCredential);
  const syncNow = useAtomCommand(taskSourcesEnvironment.syncNow);
  const [form, setForm] = useState<ProviderForm>(() => formOf(settings));
  const [token, setToken] = useState("");
  const [replacingToken, setReplacingToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const providerLabel = taskSourceProviderLabel(settings.provider);
  const state = taskSourceState(settings);
  const isGithub = settings.provider === "github_issues";
  const Icon = isGithub ? CircleDotIcon : FileTextIcon;

  const input = (
    patch: Partial<HoustonTaskSourceSettingsInput> = {},
  ): HoustonTaskSourceSettingsInput => ({
    enabled: settings.enabled,
    githubRepository: blankToNull(form.repository),
    githubLabel: blankToNull(form.label),
    githubAssignedUser: blankToNull(form.assignedUser),
    notionDataSourceId: blankToNull(form.dataSourceId),
    notionTitlePropertyId: blankToNull(form.titlePropertyId),
    notionDescriptionPropertyId: blankToNull(form.descriptionPropertyId),
    notionStatusPropertyId: blankToNull(form.statusPropertyId),
    notionAssigneePropertyId: blankToNull(form.assigneePropertyId),
    notionProjectRelationPropertyId: blankToNull(form.projectRelationPropertyId),
    notionAssigneeUserId: blankToNull(form.assigneeUserId),
    notionActiveStatusValues: parseStatusValues(form.activeStatuses),
    notionProjectsDataSourceId: blankToNull(form.projectsDataSourceId),
    notionProjectTitlePropertyId: blankToNull(form.projectTitlePropertyId),
    notionProjectDescriptionPropertyId: blankToNull(form.projectDescriptionPropertyId),
    notionPrUrlPropertyId: blankToNull(form.prUrlPropertyId),
    notionStatusMapping: form.statusMapping,
    ...patch,
  });

  const save = async (patch: Partial<HoustonTaskSourceSettingsInput> = {}) => {
    if (busy) return;
    setBusy(true);
    const outcome = await saveSettings({
      environmentId,
      input: {
        projectId,
        provider: settings.provider,
        expectedRevision: settings.revision,
        settings: input(patch),
      },
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `${providerLabel} not saved`,
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  const setNotionToken = async () => {
    const value = token.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    const outcome = await setCredential({
      environmentId,
      input: {
        projectId,
        provider: "notion",
        token: Redacted.make(value),
      },
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Notion token not saved",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
      return;
    }
    setToken("");
    setReplacingToken(false);
  };

  const clearNotionToken = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await clearCredential({
      environmentId,
      input: { projectId, provider: "notion" },
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Notion token not removed",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  const runSync = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await syncNow({ environmentId, input: { projectId } });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `${providerLabel} not synced`,
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Glyph icon={Icon} className="size-4" />
          <Text variant="headline" weight="medium">
            {providerLabel}
          </Text>
          {stateBadge(state)}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runSync()}>
            <RefreshCwIcon aria-hidden />
            Sync now
          </Button>
          <Switch
            size="sm"
            checked={settings.enabled}
            disabled={busy}
            aria-label={`Enable ${providerLabel}`}
            onCheckedChange={(checked) => void save({ enabled: Boolean(checked) })}
          />
        </div>
      </div>
      <SettingsGroup>
        {isGithub ? (
          <>
            <SettingsRow
              title="Repository"
              description="owner/repository. Reads issues with your gh sign-in."
              control={
                <Input
                  font="mono"
                  className="w-56"
                  value={form.repository}
                  placeholder="owner/repository"
                  aria-label="GitHub repository"
                  onChange={(event) => setForm({ ...form, repository: event.currentTarget.value })}
                />
              }
            />
            <SettingsRow
              title="Label"
              description="Issues with this label become tasks."
              control={
                <Input
                  font="mono"
                  className="w-56"
                  value={form.label}
                  placeholder="houston-ready"
                  aria-label="GitHub label"
                  onChange={(event) => setForm({ ...form, label: event.currentTarget.value })}
                />
              }
            />
            <SettingsRow
              title="Assigned user"
              description="Issues assigned to this user become tasks, with or without the label."
              control={
                <Input
                  font="mono"
                  className="w-56"
                  value={form.assignedUser}
                  placeholder="theo"
                  aria-label="GitHub assigned user"
                  onChange={(event) =>
                    setForm({ ...form, assignedUser: event.currentTarget.value })
                  }
                />
              }
            />
          </>
        ) : (
          <>
            <SettingsRow
              title="Integration token"
              description="Stored as a secret on the server. A saved token is never shown again."
              control={
                settings.hasCredential ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="success">Saved</Badge>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setReplacingToken((value) => !value)}
                    >
                      {replacingToken ? "Cancel" : "Replace…"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void clearNotionToken()}
                    >
                      Clear
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="password"
                      autoComplete="off"
                      className="w-56"
                      value={token}
                      placeholder="Enter a new token"
                      aria-label="Notion integration token"
                      onChange={(event) => setToken(event.currentTarget.value)}
                    />
                    <Button
                      size="xs"
                      disabled={busy || token.trim().length === 0}
                      onClick={() => void setNotionToken()}
                    >
                      Save token
                    </Button>
                  </div>
                )
              }
            />
            {settings.hasCredential && replacingToken ? (
              <SettingsRow
                title="New token"
                description="Replaces the saved token."
                control={
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="password"
                      autoComplete="off"
                      className="w-56"
                      value={token}
                      placeholder="Enter a new token"
                      aria-label="Integration token"
                      onChange={(event) => setToken(event.currentTarget.value)}
                    />
                    <Button
                      size="xs"
                      disabled={busy || token.trim().length === 0}
                      onClick={() => void setNotionToken()}
                    >
                      Save token
                    </Button>
                  </div>
                }
              />
            ) : null}
            <SettingsRow
              title="Tasks data source"
              description="The Notion database Houston reads tasks from."
              control={
                <Input
                  font="mono"
                  className="w-56"
                  value={form.dataSourceId}
                  placeholder="8f3a…"
                  aria-label="Notion tasks data source"
                  onChange={(event) =>
                    setForm({ ...form, dataSourceId: event.currentTarget.value })
                  }
                />
              }
            />
            <SettingsRow
              title="Assignee"
              description="Only pages assigned to this Notion user."
              control={
                <Input
                  font="mono"
                  className="w-56"
                  value={form.assigneeUserId}
                  placeholder="b17d…"
                  aria-label="Notion assignee user"
                  onChange={(event) =>
                    setForm({ ...form, assigneeUserId: event.currentTarget.value })
                  }
                />
              }
            />
            <SettingsRow
              title="Active statuses"
              description="Comma-separated Notion options Houston treats as open."
              control={
                <Input
                  className="w-56"
                  value={form.activeStatuses}
                  placeholder="Todo, In progress"
                  aria-label="Notion active statuses"
                  onChange={(event) =>
                    setForm({ ...form, activeStatuses: event.currentTarget.value })
                  }
                />
              }
            />
            <FoldedSettingsSection
              id={`notion-status-mapping-${settings.projectId}`}
              title="Status mapping"
              summary="Five Houston statuses to Notion options."
            >
              {(
                [
                  ["todo", "Todo"],
                  ["inProgress", "In progress"],
                  ["inReview", "In review"],
                  ["done", "Done"],
                  ["canceled", "Canceled"],
                ] as const
              ).map(([key, label]) => (
                <SettingsRow
                  key={key}
                  title={label}
                  control={
                    <Input
                      className="w-56"
                      value={form.statusMapping[key] ?? ""}
                      aria-label={`Notion option for ${label}`}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          statusMapping: {
                            ...form.statusMapping,
                            [key]: blankToNull(event.currentTarget.value),
                          },
                        })
                      }
                    />
                  }
                />
              ))}
            </FoldedSettingsSection>
            <FoldedSettingsSection
              id={`notion-property-mapping-${settings.projectId}`}
              title="Property mapping"
              summary="The Notion property IDs Houston reads and writes."
            >
              {(
                [
                  ["titlePropertyId", "Title property", form.titlePropertyId],
                  ["descriptionPropertyId", "Description property", form.descriptionPropertyId],
                  ["statusPropertyId", "Status property", form.statusPropertyId],
                  ["assigneePropertyId", "Assignee property", form.assigneePropertyId],
                  [
                    "projectRelationPropertyId",
                    "Project relation property",
                    form.projectRelationPropertyId,
                  ],
                  ["projectsDataSourceId", "Projects data source", form.projectsDataSourceId],
                  ["projectTitlePropertyId", "Project title property", form.projectTitlePropertyId],
                  [
                    "projectDescriptionPropertyId",
                    "Project description property",
                    form.projectDescriptionPropertyId,
                  ],
                  ["prUrlPropertyId", "Pull request URL property", form.prUrlPropertyId],
                ] as const
              ).map(([key, label, value]) => (
                <SettingsRow
                  key={key}
                  title={label}
                  control={
                    <Input
                      font="mono"
                      className="w-56"
                      value={value}
                      aria-label={label}
                      onChange={(event) => setForm({ ...form, [key]: event.currentTarget.value })}
                    />
                  }
                />
              ))}
            </FoldedSettingsSection>
          </>
        )}
      </SettingsGroup>
      {settings.lastError === null ? null : (
        <div className="px-1">
          <Text variant="caption" tone="danger">
            {settings.lastError}
          </Text>
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function ProjectSourcesSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const projects = useAtomValue(environmentProjects.projectsAtom)
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id as string, title: project.title }));
  const [selected, setSelected] = useState<string | null>(null);
  const projectId = selected ?? projects[0]?.id ?? null;
  if (projectId === null) {
    return (
      <SettingsSection title="Project sources">
        <Empty size="compact">
          <EmptyTitle>No workspace to configure</EmptyTitle>
          <EmptyDescription>Source settings belong to a workspace.</EmptyDescription>
        </Empty>
      </SettingsSection>
    );
  }
  return (
    <ProjectSourcesContent
      key={projectId}
      environmentId={environmentId}
      projects={projects}
      projectId={projectId}
      onSelect={setSelected}
    />
  );
}

function ProjectSourcesContent({
  environmentId,
  projects,
  projectId,
  onSelect,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  projectId: string;
  onSelect: (projectId: string) => void;
}) {
  const typedProjectId = projectId as ProjectId;
  const settingsResult = useAtomValue(
    taskSourcesEnvironment.settings({ environmentId, input: { projectId: typedProjectId } }),
  );
  return (
    <SettingsSection
      id="task-sources-project"
      title="Project sources"
      headerAction={
        <div className="w-48">
          <Select
            value={projectId}
            onValueChange={(value) => {
              if (typeof value === "string") onSelect(value);
            }}
          >
            <SelectTrigger aria-label="Project sources workspace">
              <SelectValue>
                {projects.find((project) => project.id === projectId)?.title ??
                  "Choose a workspace"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
      variant="plain"
    >
      {AsyncResult.isInitial(settingsResult) ? (
        <Skeleton className="h-52 w-full" />
      ) : AsyncResult.isFailure(settingsResult) ? (
        <Alert variant="error">
          <AlertDescription>
            {readableFailure(squashAtomCommandFailure(settingsResult))}
          </AlertDescription>
        </Alert>
      ) : (
        settingsResult.value.map((settings) => (
          <ProviderCard
            key={`${settings.provider}:${settings.revision}`}
            environmentId={environmentId}
            settings={settings}
            projectId={typedProjectId}
          />
        ))
      )}
    </SettingsSection>
  );
}

function ConflictsBanner({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const conflictsResult = useAtomValue(
    taskSourcesEnvironment.conflicts({ environmentId, input: {} }),
  );
  const count = AsyncResult.isSuccess(conflictsResult) ? conflictsResult.value.length : 0;
  if (count === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <TriangleAlertIcon aria-hidden />
      <AlertDescription>
        {count} task{count === 1 ? "" : "s"} changed in both Houston and a tracker. Choose which
        value to keep on each task.
      </AlertDescription>
      <AlertAction>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigate({ to: "/tasks", search: { view: "sources" } as never })}
        >
          Review in Tasks
        </Button>
      </AlertAction>
    </Alert>
  );
}

function importDescription(
  status: HoustonTaskSourceImportStatus | HoustonSlackImportStatus,
): string {
  switch (status.state) {
    case "available": {
      if ("settings" in status) {
        return `${status.settings} source settings and ${status.links} task links in ${status.source}.`;
      }
      return `${status.channels} channels and ${status.requests} requests in ${status.source}.`;
    }
    case "imported":
      return "links" in status.counts
        ? `${status.counts.settings} source settings and ${status.counts.links} links imported.`
        : `${status.counts.channels} channels and ${status.counts.requests} requests imported.`;
    case "blocked":
      return status.reason;
    case "unavailable":
      return "No Houston 1 data was found on this machine.";
  }
}

function ImportSection({ environmentId }: { environmentId: EnvironmentId }) {
  const sourcesStatus = useAtomValue(
    taskSourcesEnvironment.importStatus({ environmentId, input: {} }),
  );
  const slackStatus = useAtomValue(slackEnvironment.importStatus({ environmentId, input: {} }));
  const runSources = useAtomCommand(taskSourcesEnvironment.importRun);
  const runSlack = useAtomCommand(slackEnvironment.importRun);
  const [busy, setBusy] = useState<"sources" | "slack" | null>(null);

  const run = async (kind: "sources" | "slack") => {
    if (busy !== null) return;
    setBusy(kind);
    const outcome =
      kind === "sources"
        ? await runSources({ environmentId, input: {} })
        : await runSlack({ environmentId, input: {} });
    setBusy(null);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Import failed",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  const rows: ReadonlyArray<{
    readonly kind: "sources" | "slack";
    readonly title: string;
    readonly status: HoustonTaskSourceImportStatus | HoustonSlackImportStatus | null;
  }> = [
    {
      kind: "sources",
      title: "Task source history",
      status: AsyncResult.isSuccess(sourcesStatus) ? sourcesStatus.value : null,
    },
    {
      kind: "slack",
      title: "Slack intake",
      status: AsyncResult.isSuccess(slackStatus) ? slackStatus.value : null,
    },
  ];

  return (
    <SettingsSection id="task-sources-import" title="Houston 1 data">
      <SettingsGroup>
        {rows.map((row) => (
          <SettingsRow
            key={row.kind}
            title={`Import ${row.title.toLowerCase()}`}
            description={
              row.status === null ? "Checking for Houston 1 data…" : importDescription(row.status)
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || row.status?.state !== "available"}
                onClick={() => void run(row.kind)}
              >
                {row.status?.state === "imported" ? "Imported" : "Import"}
              </Button>
            }
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

export function TaskSourcesSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyTitle>No environment is connected</EmptyTitle>
          <EmptyDescription>Task sources need a connected environment.</EmptyDescription>
        </Empty>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <ConflictsBanner environmentId={environmentId} />
      <SlackSettings environmentId={environmentId} />
      <ProjectSourcesSettings environmentId={environmentId} />
      <ImportSection environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
