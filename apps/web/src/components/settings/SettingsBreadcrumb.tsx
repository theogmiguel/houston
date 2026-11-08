import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SETTINGS_NAV_GROUPS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

const TRAILING_SLASHES = /\/+$/;

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(TRAILING_SLASHES, "") || "/";
  return SETTINGS_BREADCRUMB_LABELS[normalizedPathname] ?? null;
}

/** Pages the sidebar nav lists: from md up the nav already marks the open one. */
function navShowsLocation(pathname: string): boolean {
  const normalizedPathname = pathname.replace(TRAILING_SLASHES, "") || "/";
  return SETTINGS_NAV_GROUPS.some((group) =>
    group.paths.some((to) => normalizedPathname === to || normalizedPathname.startsWith(`${to}/`)),
  );
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);

  return (
    <WorkspaceBreadcrumb
      ariaLabel="Settings breadcrumb"
      // Below md the nav is an icon rail without names, so the breadcrumb is the location there.
      {...(navShowsLocation(pathname) ? { className: "md:hidden" } : {})}
    >
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem className="font-normal">Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate font-semibold">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
