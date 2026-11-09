import { GridSidebar } from "../components/grid/GridSidebar";
import { Sidebar, SidebarInset } from "../components/ui/sidebar";
import { workspaceAreaProps } from "../lib/workspaceFocus";

/** The phone's home: the rail's own content as a full-screen page, without a draft thread. */
export function PhoneHome() {
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Home")}
      role="main"
      className="min-h-0 overflow-hidden"
      data-phone-home=""
    >
      <div className="flex min-h-0 flex-1 flex-col pt-safe pb-safe">
        <Sidebar
          collapsible="none"
          role="navigation"
          aria-label="Threads"
          className="w-full min-h-0"
        >
          <GridSidebar hideTasks isPage />
        </Sidebar>
      </div>
    </SidebarInset>
  );
}
