import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@houston-app/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FolderPlusIcon,
  GitForkIcon,
  InfoIcon,
  MessageSquareDashedIcon,
  SettingsIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { openAddProjectDialog } from "./AddProjectDialog";
import { isDesktopHost } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import {
  getOnboardingProviderState,
  selectOnboardingProvidersByDriver,
} from "../onboarding/providerReadiness.logic";
import {
  useEnvironmentHttpBaseUrl,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { useHouston1Import } from "./settings/useHouston1Import";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Text } from "./ui/text";
import { HoustonMark } from "./HoustonWordmark";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

const INTRO_TERMS = [
  { term: "Project", definition: "a folder on this machine." },
  { term: "Thread", definition: "a conversation with one agent, in a project or not." },
  { term: "Workspace", definition: "tabs side by side; any project's threads share one." },
] as const;

const PROVIDER_LABELS: Partial<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
  muse: "Muse Code",
  fx: "fx",
};

function providerLabel(provider: Pick<ServerProvider, "driver" | "displayName">): string {
  return PROVIDER_LABELS[provider.driver] || provider.displayName || provider.driver;
}

/** How many providers are ready, need a sign-in or a fix, or are not installed. */
function summarizeProviders(providers: ReadonlyArray<ServerProvider>) {
  const ready: string[] = [];
  let needsAttention = 0;
  let notInstalled = 0;
  for (const provider of providers) {
    const state = getOnboardingProviderState(provider);
    if (state === "ready") ready.push(providerLabel(provider));
    else if (state === "install" || (state === "disabled" && !provider.installed))
      notInstalled += 1;
    else if (state === "signIn" || state === "attention") needsAttention += 1;
  }
  return { ready, needsAttention, notInstalled };
}

/** One line that says where providers stand; the settings page it links to has the detail. */
export function providerStatusLine(providers: ReadonlyArray<ServerProvider>): string {
  if (providers.length === 0) return "No providers found";
  const { ready, needsAttention, notInstalled } = summarizeProviders(providers);
  const parts: string[] = [];
  if (ready.length > 0) {
    parts.push(
      ready.length <= 2 ? `${ready.join(" and ")} ready` : `${ready.length} providers ready`,
    );
  }
  if (needsAttention > 0)
    parts.push(`${needsAttention} need${needsAttention === 1 ? "s" : ""} attention`);
  if (notInstalled > 0) parts.push(`${notInstalled} not installed`);
  return parts.length > 0 ? parts.join(" · ") : "Checking providers…";
}

export function NoProjectsHero() {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironmentId);
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const navigate = useNavigate();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const houston1 = useHouston1Import(primaryEnvironmentId);
  const houston1Projects =
    primaryEnvironmentId !== null && houston1.statuses.tasks?.state === "available"
      ? (houston1.statuses.tasks.workspaceCount ?? 0)
      : 0;
  const canImportHouston1 = houston1Projects > 0;
  const providers =
    (primaryEnvironmentId === null
      ? undefined
      : providersByEnvironment.get(primaryEnvironmentId)) ?? primaryProviders;
  const byDriver = selectOnboardingProvidersByDriver(providers);
  const knownProviders = [...byDriver.values()];
  const statusLine = providerStatusLine(knownProviders);
  const providersOk = summarizeProviders(knownProviders).needsAttention === 0;
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);
  const openProviderSetup = () => {
    void navigate({ to: "/settings/providers" });
  };
  const serverAddress = (() => {
    if (environmentHttpBaseUrl === null) return null;
    try {
      return new URL(environmentHttpBaseUrl).host;
    } catch {
      return null;
    }
  })();

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader desktop={isDesktopHost} />
        <Empty size="welcome" className="flex-1">
          <div className="flex w-full max-w-[560px] flex-col items-center gap-3.5 py-12">
            <EmptyMedia className="mb-0">
              <HoustonMark className="size-14" />
            </EmptyMedia>
            <EmptyTitle variant="display">Add a project to start</EmptyTitle>
            <EmptyDescription variant="welcome" className="max-w-[62ch]">
              Threads run on Houston's local server and keep running when you close the window.
            </EmptyDescription>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {canImportHouston1 ? (
                <Button disabled={houston1.busy} onClick={() => void houston1.run()}>
                  {houston1.busy
                    ? "Importing…"
                    : `Import ${houston1Projects} ${houston1Projects === 1 ? "project" : "projects"} from Houston 1`}
                </Button>
              ) : null}
              <Button
                variant={canImportHouston1 ? "outline" : "default"}
                onClick={() => openAddProjectDialog({ action: "open-folder" })}
              >
                <FolderPlusIcon className="size-4" />
                Add folder
              </Button>
              <Button variant="outline" onClick={() => openAddProjectDialog({ action: "clone" })}>
                <GitForkIcon className="size-4" />
                Clone a repository
              </Button>
            </div>
            {canImportHouston1 ? (
              houston1.failure !== null ? (
                <Text
                  as="p"
                  variant="caption"
                  tone="danger"
                  role="alert"
                  className="mt-2 max-w-[62ch]"
                >
                  {houston1.failure}
                </Text>
              ) : (
                <EmptyDescription className="mt-2 max-w-[62ch]">
                  {houston1.description}
                </EmptyDescription>
              )
            ) : null}
            <EmptyDescription className="mt-1 max-w-[62ch]">
              {INTRO_TERMS.map(({ term, definition }) => (
                <Text key={term} as="p" variant="caption" tone="inherit" data-hero-term={term}>
                  <Text as="span" variant="caption" tone="inherit" weight="semibold">
                    {term}
                  </Text>
                  : {definition}
                </Text>
              ))}
            </EmptyDescription>
            <div className="mt-3 flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={openProviderSetup}>
                {providersOk ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <CircleAlertIcon className="size-4 text-(--warn)" />
                )}
                {statusLine}
                <ChevronRightIcon className="size-3.5 text-(--houston)" />
              </Button>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button variant="ghost" size="icon-xs" aria-label="Where your prompts go" />
                  }
                >
                  <InfoIcon className="size-4" />
                </PopoverTrigger>
                <PopoverPopup side="top" className="w-72">
                  <p className="text-xs leading-4 text-secondary-label">
                    The server listens on {serverAddress ?? "this machine"} only. Each agent sends
                    your prompts and the files it reads to its own provider; Houston sends nothing
                    else.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 -ms-2"
                    onClick={() => void navigate({ to: "/welcome", hash: "setup" })}
                  >
                    <SettingsIcon className="size-4" />
                    Set up Houston
                  </Button>
                </PopoverPopup>
              </Popover>
            </div>
            {scratchTargetEnvironmentId === null ? null : (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
              >
                <MessageSquareDashedIcon className="size-4" />
                Start without a project
              </Button>
            )}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
