import { PlusIcon } from "lucide-react";
import { RAIL_EMPTY_HINT_CLS, RAIL_EMPTY_TITLE_CLS } from "../ui/sidebar-rail-recipes";

import { openAddProjectDialog } from "../AddProjectDialog";
import { SIDEBAR_PROJECT_EMPTY_ACTION_CLS } from "../ui/sidebar-sections";

/** The rail with no project to list: says why it is empty and offers the way out. */
export function SidebarNoProjects() {
  return (
    <div data-sidebar-no-projects="" className="flex flex-col gap-1 px-2 py-3">
      <p className={RAIL_EMPTY_TITLE_CLS}>No projects yet</p>
      <p className={RAIL_EMPTY_HINT_CLS}>Add a project to create its first grid.</p>
      <button
        type="button"
        onClick={() => openAddProjectDialog()}
        className={SIDEBAR_PROJECT_EMPTY_ACTION_CLS}
      >
        <PlusIcon aria-hidden className="size-3.5" />
        <span>Add project</span>
      </button>
    </div>
  );
}
