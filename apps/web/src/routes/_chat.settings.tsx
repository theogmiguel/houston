import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Swap } from "../components/ui/swap";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { AppRouteModal } from "../components/AppRouteModal";
import { useIsPhone } from "../mobile/usePhone";
import { PHONE_PAGE_BAR_BACK_CLS, PHONE_PAGE_BAR_CLS } from "../components/ui/phone-recipes";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import {
  SettingsPageActionsProvider,
  SettingsPageContainer,
} from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      <span className="max-sm:sr-only">Restore defaults</span>
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `${searchTarget.title} requires a supporting environment. Choose one to continue.`
          : `${searchTarget.title} requires a supporting environment. Connect or update an environment to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Reconnect {scope.label} to change its settings.
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const contentArea = workspaceAreaProps("settings", 1, "Settings content");
  const location = useLocation();
  const isPhone = useIsPhone();
  // The phone shows the section list as a page of its own; the content keeps a Back control.
  const [phoneSectionsOpen, setPhoneSectionsOpen] = useState(false);
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || location.pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);

  const content = (
    <div {...contentArea} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        data-drag-region="deep"
        className={
          isPhone
            ? PHONE_PAGE_BAR_CLS
            : "flex h-10 shrink-0 items-center gap-2 ps-3.5 pe-2 custom-chrome:pe-(--workspace-native-controls-inset)"
        }
      >
        {isPhone ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Back to settings sections"
            className={PHONE_PAGE_BAR_BACK_CLS}
            onClick={() => setPhoneSectionsOpen(true)}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        ) : null}
        <SettingsBreadcrumb pathname={location.pathname} />
      </header>
      <Swap
        swapKey={`${location.pathname}:${contentScopeKey}:${restoreSignal}`}
        className="min-h-0 flex flex-1 flex-col"
        contentClassName="min-h-0 flex flex-1 flex-col"
        innerClassName="min-h-0 flex flex-1 flex-col"
      >
        <SettingsScopeBoundary pathname={location.pathname}>
          <SettingsPageActionsProvider
            actions={
              location.pathname === "/settings/about" ||
              location.pathname === "/settings/open-source-licenses" ||
              location.pathname === "/settings/archived" ? null : (
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              )
            }
          >
            <Outlet />
          </SettingsPageActionsProvider>
        </SettingsScopeBoundary>
      </Swap>
    </div>
  );

  return (
    <AppRouteModal label="Settings" fullscreen>
      <div className="relative flex min-h-0 flex-1">
        {isPhone ? (
          phoneSectionsOpen ? (
            <SettingsSidebarNav
              pathname={location.pathname}
              phonePage
              onNavigate={() => setPhoneSectionsOpen(false)}
            />
          ) : (
            content
          )
        ) : (
          <>
            <SettingsSidebarNav pathname={location.pathname} />
            {content}
          </>
        )}
      </div>
    </AppRouteModal>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers" || pathname === "/settings/secrets"}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsRouteLayout,
});
