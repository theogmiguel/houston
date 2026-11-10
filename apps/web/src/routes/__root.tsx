import { type ServerLifecycleWelcomePayload } from "@houston-app/contracts";
import { scopedProjectKey, scopeProjectRef } from "@houston-app/client-runtime/environment";
import {
  Outlet,
  Link,
  redirect,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { ThreadTagsDialogHost } from "../components/ThreadTagsDialog";
import { AddProjectDialogHost } from "../components/AddProjectDialog";
import { UseInAnotherAppDialogHost } from "../components/mcp/UseInAnotherAppDialog";
import { AddProjectToMachineDialogHost } from "../components/AddProjectToMachineDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { DevReplayHost } from "../components/DevReplayHost";
import { FirstRunGate } from "../components/onboarding/FirstRunGate";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { SnapShotCoordinator } from "../components/desktop/SnapShotCoordinator";
import { DesktopAppActivationCoordinator } from "../components/desktop/DesktopAppActivationCoordinator";
import { DesktopWebLinkCoordinator } from "../components/desktop/DesktopWebLinkCoordinator";
import { RunningThreadKeepAlive } from "../components/desktop/RunningThreadKeepAlive";
import { ReopenClosedViewShortcut } from "../components/ReopenClosedViewShortcut";
import { ProjectCloneToastCoordinator } from "../components/ProjectCloneToastCoordinator";
import { ChatGptWelcomeCoordinator } from "../components/settings/ChatGptWelcomeCoordinator";
import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import { RouteErrorActions } from "../components/RouteErrorActions";
import { ServerUnavailableCard } from "../components/ServerUnavailableCard";
import { Button } from "../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isDesktopHost } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "@houston-app/client-runtime/state/project-grouping";
import { useUiStateStore } from "../uiStateStore";
import { configureClientTracing } from "../observability/clientTracing";
import {
  readPrimaryEnvironmentTarget,
  resolveInitialServerAuthGateState,
} from "../environments/primary";
import { PrimaryEnvironmentRequestError } from "../environments/primary/auth";
import {
  serverUnavailableDetail,
  serverUnavailableOutcome,
} from "../components/serverUnavailableDetail";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { useHostedPromptLinkLanding } from "../components/promptLinks/HostedPromptLinkLanding";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../state/server";
import { readProject } from "../state/entities";

import { getDesktopSnapShotBridge } from "../lib/desktopSnapShot";
import { shouldResumeSnapShotSetupOnStartup } from "../lib/snapShotSetupResume";

const isPrimaryEnvironmentRequestError = Schema.is(PrimaryEnvironmentRequestError);

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isLocalEnvironmentDisabled() || isHostedStaticApp(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialServerAuthGateState();
    if (authGateState.status === "authenticated") {
      // Idempotent, so every navigation can ask for it.
      void configureClientTracing();
    }
    if (
      authGateState.status === "authenticated" &&
      getDesktopSnapShotBridge() &&
      shouldResumeSnapShotSetupOnStartup() &&
      location.pathname !== "/settings/snap-shot" &&
      location.pathname !== "/quick-composer"
    ) {
      throw redirect({ to: "/settings/snap-shot", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}. Go home to choose a project or
          start a thread.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  // Above every branch: app services raise toasts for the whole page, so the surface they write to
  // must not unmount when the root switches branches (for example /welcome to the app shell).
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <RootRouteBranch />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteBranch() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";
  // A sync IPC read; the setting only changes across a relaunch.
  const [localEnvironmentDisabled] = useState(isLocalEnvironmentDisabled);
  // Once true, stays true: a visit to /welcome means the bootstrap already chose a route.
  const [returningFromWelcome, setReturningFromWelcome] = useState(pathname === "/welcome");
  if (pathname === "/welcome" && !returningFromWelcome) setReturningFromWelcome(true);
  const hostedPromptLinkLanding = useHostedPromptLinkLanding(
    authGateState.status === "hosted-static",
  );

  if (pathname === "/pair" || pathname === "/connect-agent" || pathname === "/quick-composer") {
    return <Outlet />;
  }

  // Handle links before onboarding redirects lose them.
  if (hostedPromptLinkLanding !== null) {
    return hostedPromptLinkLanding;
  }

  if (pathname === "/welcome") {
    return (
      <>
        <CustomSnoozeDialogHost />
        <ThreadTagsDialogHost />
        <AddProjectDialogHost />
        <UseInAnotherAppDialogHost />
        <CommandPalette>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>
        </CommandPalette>
      </>
    );
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <>
      <ChatGptWelcomeCoordinator />
      <AddProjectDialogHost />
      <UseInAnotherAppDialogHost />
      <FirstRunGate
        enabled={primaryEnvironmentAuthenticated}
        hostedStatic={authGateState.status === "hosted-static"}
      >
        {primaryEnvironmentAuthenticated ? <DesktopAppActivationCoordinator /> : null}
        {primaryEnvironmentAuthenticated || localEnvironmentDisabled ? (
          <DesktopWebLinkCoordinator />
        ) : null}
        {isDesktopHost ? <RunningThreadKeepAlive /> : null}
        <SshPasswordPromptDialog />
        <SnapShotCoordinator />
        <ReopenClosedViewShortcut />
        <ConfirmDialogHost />
        <CustomSnoozeDialogHost />
        <ThreadTagsDialogHost />
        <ProjectCloneToastCoordinator />
        <AddProjectToMachineDialogHost />
        {import.meta.env.DEV && primaryEnvironmentAuthenticated ? <DevReplayHost /> : null}
        {primaryEnvironmentAuthenticated ? (
          <EventRouter skipInitialBootstrapNavigation={returningFromWelcome} />
        ) : null}
        {appShell}
        {/* Keep the theme editor above the router so drafts survive navigation. */}
        <ThemeEditorHost />
      </FirstRunGate>
    </>
  );
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  if (isPrimaryEnvironmentRequestError(error)) {
    return <ServerUnavailableView error={error} />;
  }
  return <GenericRouteErrorView error={error} />;
}

function ServerUnavailableView({ error }: { error: PrimaryEnvironmentRequestError }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  // The card's headline is a sentence; the error tag and operation live in the log and the copy.
  const report = `${serverUnavailableOutcome(error)}\n\n${errorReport(error, pathname)}`;
  return (
    <ServerUnavailableCard
      report={report}
      detail={serverUnavailableDetail(error, primaryTargetHost())}
    />
  );
}

/** The host the client tried, or null when the target itself cannot be resolved. */
function primaryTargetHost(): string | null {
  try {
    const target = readPrimaryEnvironmentTarget();
    return target === null ? null : new URL(target.target.httpBaseUrl).host;
  } catch {
    return null;
  }
}

function GenericRouteErrorView({ error }: Pick<ErrorComponentProps, "error">) {
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = errorReport(error, pathname);

  return (
    <StandalonePage>
      <StandalonePageHeader title="Something went wrong." description={message} />

      <RouteErrorActions report={report} />

      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Error report</p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </StandalonePage>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

// Use only pathname to keep query tokens off the clipboard.
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${APP_VERSION}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

function EventRouter({
  skipInitialBootstrapNavigation,
}: {
  readonly skipInitialBootstrapNavigation: boolean;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const skipInitialBootstrapNavigationRef = useRef(skipInitialBootstrapNavigation);

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (skipInitialBootstrapNavigationRef.current) {
        skipInitialBootstrapNavigationRef.current = false;
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- expands the bootstrap project in the UI store and navigates the router on a server welcome
  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  return null;
}
