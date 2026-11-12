import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { projectScriptCwd } from "@houston-app/shared/projectScripts";

import { ThreadSurfaceContent } from "../components/chat/ThreadSurfaceContent";
import { ThreadTerminalDock } from "../components/terminal/ThreadTerminalDock";
import type { PersistentTerminalLaunchContext } from "../components/PersistentThreadTerminals";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProject, useQuietThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { THREAD_TERMINAL_SURFACE_ID, type LayoutSurfaceContent } from "./layoutModel";
import { useLayoutPane } from "./layoutPaneContext";
import { useThreadChatBridge } from "./threadSurfaceBridge";

/** One surface of a thread (changes, files, a browser, a pull request…) or its terminal. */
export function LayoutSurfaceTab({ content }: { readonly content: LayoutSurfaceContent }) {
  const { visible } = useLayoutPane();
  return (
    <div
      data-layout-surface-tab={content.surfaceId}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {content.surfaceId === THREAD_TERMINAL_SURFACE_ID ? (
        <LayoutTerminalTab threadRef={content.threadRef} />
      ) : (
        <ThreadSurfaceContent
          threadRef={content.threadRef}
          surfaceId={content.surfaceId}
          visible={visible}
        />
      )}
    </div>
  );
}

function LayoutTerminalTab({
  threadRef,
}: {
  readonly threadRef: LayoutSurfaceContent["threadRef"];
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shell = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectId = shell?.projectId ?? draftThread?.projectId ?? null;
  const projectRef =
    projectId === null ? null : scopeProjectRef(threadRef.environmentId, projectId);
  const project = useProject(projectRef);
  const bridge = useThreadChatBridge(threadRef);
  if (projectRef === null) return null;
  const worktreePath = shell?.worktreePath ?? draftThread?.worktreePath ?? null;
  const launchContext: PersistentTerminalLaunchContext | null =
    bridge?.terminalLaunchContext ??
    (project === null
      ? null
      : {
          cwd: projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }),
          worktreePath,
        });
  return (
    <ThreadTerminalDock
      fill
      threadRef={threadRef}
      projectRef={projectRef}
      launchContext={launchContext}
      keybindings={keybindings}
    />
  );
}
