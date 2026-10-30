import { workspaceAreaProps } from "../lib/workspaceFocus";
import { FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useScratchProject } from "../hooks/useScratchProject";
import { isTauriHost } from "../lib/desktopWindow";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { HoustonMark } from "./HoustonWordmark";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const scratchTargetEnvironmentId = scratchEnvironmentId(primaryEnvironmentId);

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron || isTauriHost() ? <WorkspacePageHeader electron={isElectron} /> : null}
        <Empty size="welcome" className="flex-1">
          <div className="flex w-full max-w-[560px] flex-col items-center px-8 py-12">
            <EmptyMedia className="mb-3.5">
              <HoustonMark className="size-14" />
            </EmptyMedia>
            <EmptyTitle variant="display">What should we work on?</EmptyTitle>
            <EmptyDescription variant="welcome" className="mt-2 max-w-[62ch]">
              {scratchTargetEnvironmentId === null
                ? "Add a project to start your first thread."
                : "Add a project, or start without one."}
            </EmptyDescription>
            <div className="mt-5 flex justify-center gap-2">
              <Button onClick={() => openCommandPalette({ open: "add-project" })}>
                <FolderPlusIcon className="size-4" />
                Add project
              </Button>
              {scratchTargetEnvironmentId === null ? null : (
                <Button
                  variant="outline"
                  onClick={() => void startScratchThread(scratchTargetEnvironmentId)}
                >
                  <MessageSquareDashedIcon className="size-4" />
                  Start without a project
                </Button>
              )}
            </div>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
