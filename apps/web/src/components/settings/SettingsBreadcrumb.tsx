import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";

/** Names the area only: each settings page carries its own title, so a section segment would repeat it. */
export function SettingsBreadcrumb() {
  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      <WorkspaceBreadcrumbItem current className="truncate">
        Settings
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
