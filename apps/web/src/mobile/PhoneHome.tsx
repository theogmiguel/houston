import { PlusIcon, SearchIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { GridSidebar } from "../components/grid/GridSidebar";
import { HoustonWordmark } from "../components/HoustonWordmark";
import { Button } from "../components/ui/button";
import { PHONE_HOME_BAR_CLS, PHONE_HOME_BRAND_CLS } from "../components/ui/phone-recipes";
import { Sidebar, SidebarInset } from "../components/ui/sidebar";
import { workspaceAreaProps } from "../lib/workspaceFocus";

/** The phone's home: the rail's own content as a page, under a bar with search and new thread. */
export function PhoneHome() {
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Home")}
      role="main"
      className="min-h-0 overflow-hidden"
      data-phone-home=""
    >
      <header className={PHONE_HOME_BAR_CLS}>
        <HoustonWordmark className={PHONE_HOME_BRAND_CLS} markClassName="size-[22px]" />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Search"
            className="size-11"
            onClick={() => openCommandPalette()}
          >
            <SearchIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New thread"
            className="size-11"
            onClick={() => openCommandPalette({ open: "new-thread-in" })}
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
      </header>
      <Sidebar
        collapsible="none"
        role="navigation"
        aria-label="Threads"
        className="h-auto w-full min-h-0 flex-1"
      >
        <GridSidebar isPage />
      </Sidebar>
    </SidebarInset>
  );
}
