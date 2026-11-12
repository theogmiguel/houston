import type { ReactNode } from "react";

/**
 * The rail's fixed top entries, shared by the thread sidebar: the search field with the rail's
 * quiet icon buttons to its right. Pull requests, Tasks and Usage live in the footer.
 */
export function SidebarRailNav({ search, actions }: { search: ReactNode; actions?: ReactNode }) {
  return (
    <div data-rail-search-row="" className="flex items-center gap-0.5">
      <div className="min-w-0 flex-1">{search}</div>
      {actions}
    </div>
  );
}
