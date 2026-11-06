import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@houston-app/contracts";
import { FolderPlusIcon, GitForkIcon, MessageSquareDashedIcon, SettingsIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "../branding";
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
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { StatusList, StatusListDisclosure, StatusListRow } from "./ui/status-list";
import { HoustonMark } from "./HoustonWordmark";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

const PROVIDER_ORDER = [
  "claudeAgent",
  "codex",
  "opencode",
  "antigravity",
  "cursor",
  "grok",
  "pi",
  "muse",
  "fx",
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

function providerDetail(provider: ServerProvider | undefined): string {
  if (provider === undefined) return "Checking…";
  const state = getOnboardingProviderState(provider);
  if (state === "install") return "Not installed";
  if (state === "disabled") return provider.installed ? "Disabled" : "Not installed";
  if (state === "checking") return "Checking…";
  if (state === "signIn") {
    return provider.version ? `${provider.version} · signed out` : "Signed out";
  }
  if (state === "attention") return "Needs attention";
  return provider.version ? `${provider.version} · signed in` : "Signed in";
}

function ProviderRow({
  provider,
  divided,
  onAction,
}: {
  readonly provider: ServerProvider;
  readonly divided: boolean;
  readonly onAction: () => void;
}) {
  const state = getOnboardingProviderState(provider);
  const actionLabel =
    state === "signIn" || provider.auth.status === "unauthenticated"
      ? "Sign in"
      : !provider.installed
        ? "How to install"
        : null;
  return (
    <StatusListRow
      ready={state === "ready"}
      label={providerLabel(provider)}
      detail={providerDetail(provider)}
      divided={divided}
      {...(actionLabel === null
        ? {}
        : {
            action: {
              label: actionLabel,
              emphasis: actionLabel === "How to install" ? ("link" as const) : ("ghost" as const),
              onClick: onAction,
            },
          })}
    />
  );
}

export function NoProjectsHero() {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironmentId);
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const navigate = useNavigate();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const providers =
    (primaryEnvironmentId === null
      ? undefined
      : providersByEnvironment.get(primaryEnvironmentId)) ?? primaryProviders;
  const byDriver = selectOnboardingProvidersByDriver(providers);
  const visibleProviders = PROVIDER_ORDER.flatMap((driver) => {
    const provider = byDriver.get(driver);
    return provider === undefined ? [] : [{ driver, provider }];
  }).slice(0, 5);
  const isNotInstalled = ({ provider }: (typeof visibleProviders)[number]) =>
    providerDetail(provider) === "Not installed";
  const availableProviders = visibleProviders.filter((entry) => !isNotInstalled(entry));
  const missingProviders = visibleProviders.filter(isNotInstalled);
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
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The board's window titlebar names the product above the empty state. */}
        <WorkspacePageHeader desktop={isDesktopHost}>
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            {APP_DISPLAY_NAME}
          </span>
        </WorkspacePageHeader>
        <Empty size="welcome" className="flex-1">
          <div className="flex w-full max-w-[560px] flex-col items-center gap-3.5 py-12">
            <EmptyMedia className="mb-0">
              <HoustonMark className="size-14" />
            </EmptyMedia>
            <EmptyTitle variant="display">Add a project to start</EmptyTitle>
            <EmptyDescription variant="welcome" className="max-w-[62ch]">
              Each folder becomes a workspace. Threads run on a local server there and keep running
              when you close the window.
            </EmptyDescription>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <Button onClick={() => openAddProjectDialog()}>
                <FolderPlusIcon className="size-4" />
                Add folder
              </Button>
              <Button variant="outline" onClick={() => openAddProjectDialog()}>
                <GitForkIcon className="size-4" />
                Clone a repository
              </Button>
              {scratchTargetEnvironmentId === null ? null : (
                <Button
                  variant="ghost"
                  onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                >
                  <MessageSquareDashedIcon className="size-4" />
                  Start without a project
                </Button>
              )}
            </div>
            {visibleProviders.length > 0 ? (
              <StatusList className="mt-5 w-full">
                {availableProviders.map(({ driver, provider }, index) => (
                  <ProviderRow
                    key={driver}
                    provider={provider}
                    divided={index > 0}
                    onAction={openProviderSetup}
                  />
                ))}
                {missingProviders.length > 0 ? (
                  <StatusListDisclosure
                    summary={`${missingProviders.length} more not installed`}
                    divided={availableProviders.length > 0}
                  >
                    {missingProviders.map(({ driver, provider }) => (
                      <ProviderRow
                        key={driver}
                        provider={provider}
                        divided
                        onAction={openProviderSetup}
                      />
                    ))}
                  </StatusListDisclosure>
                ) : null}
              </StatusList>
            ) : null}
            <p className="mt-2 text-xs leading-4 text-secondary-label">
              Runs locally at {serverAddress ?? "this machine"}; prompts go only to your agent's
              provider.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigate({ to: "/welcome", hash: "setup" })}
            >
              <SettingsIcon className="size-4" />
              Set up Houston
            </Button>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
