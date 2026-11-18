import type { EnvironmentId, IssueImportStatus, ProjectId } from "@houston-app/contracts";
import type {
  HoustonSlackImportStatus,
  HoustonSlackInfo,
  HoustonSlackLanguage,
} from "@houston-app/contracts/houston/slack";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { CircleDotIcon, ExternalLinkIcon, HashIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/reactivity";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { requestConfirmDialog } from "~/confirmDialog";
import { environmentProjects } from "~/state/projects";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { slackEnvironment } from "~/state/slack";
import { v1IssueImportRun, v1IssueImportStatus } from "~/state/v1Import";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "../ui/empty";
import { Glyph } from "../ui/glyph";
import { Input } from "../ui/input";
import { Separator } from "../ui/separator";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { RelativeTime } from "../RelativeTime";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { slackConnectionState } from "../tasks/taskSources.logic";

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
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Glyph icon={CircleDotIcon} className="size-3.5" />
          <Text variant="caption" tone="muted" breakWords>
            Notion pages are issues on the Issues page; a task can be created from one.
          </Text>
        </div>
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
    return <Skeleton className="h-40 w-full max-phone:hidden" />;
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

function importDescription(status: IssueImportStatus | HoustonSlackImportStatus): string {
  switch (status.state) {
    case "available":
      return "links" in status
        ? `${status.links} Notion page link(s) in ${status.source}.`
        : `${status.channels} channels and ${status.requests} requests in ${status.source}.`;
    case "imported":
      return "links" in status.counts
        ? `${status.counts.links} Notion page link(s) imported, ${status.counts.skipped} skipped.`
        : `${status.counts.channels} channels and ${status.counts.requests} requests imported.`;
    case "blocked":
      return status.reason;
    case "unavailable":
      return "No Houston 1 data was found on this machine.";
  }
}

function ImportSection({ environmentId }: { environmentId: EnvironmentId }) {
  const issuesStatus = useAtomValue(v1IssueImportStatus({ environmentId, input: {} }));
  const slackStatus = useAtomValue(slackEnvironment.importStatus({ environmentId, input: {} }));
  const runIssues = useAtomCommand(v1IssueImportRun);
  const runSlack = useAtomCommand(slackEnvironment.importRun);
  const [busy, setBusy] = useState<"issues" | "slack" | null>(null);

  const run = async (kind: "issues" | "slack") => {
    if (busy !== null) return;
    setBusy(kind);
    const outcome =
      kind === "issues"
        ? await runIssues({ environmentId, input: {} })
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
    readonly kind: "issues" | "slack";
    readonly title: string;
    readonly status: IssueImportStatus | HoustonSlackImportStatus | null;
  }> = [
    {
      kind: "issues",
      title: "Notion issue links",
      status: AsyncResult.isSuccess(issuesStatus) ? issuesStatus.value : null,
    },
    {
      kind: "slack",
      title: "Slack intake",
      status: AsyncResult.isSuccess(slackStatus) ? slackStatus.value : null,
    },
  ];

  return (
    <SettingsSection id="task-sources-import" title="Houston 1 data">
      <SettingsGroup className="max-phone:rounded-none max-phone:border-0 max-phone:bg-transparent">
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
      <SlackSettings environmentId={environmentId} />
      <ImportSection environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
