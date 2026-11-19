import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@houston-app/client-runtime/state/models";
import {
  CircleDotIcon,
  ListChecksIcon,
  FileIcon,
  FolderTreeIcon,
  GitCompareIcon,
  GlobeIcon,
  SmartphoneIcon,
  SquareDashedIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";

import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import {
  EMPTY_PROVIDER_ENTRIES,
  sidebarProviderEntriesAtom,
} from "../components/sidebar/sidebarProviderEntries";
import {
  SidebarProviderStack,
  type SidebarProviderEntry,
} from "../components/sidebar/SidebarThreadRow";
import { type DraftThreadState, useComposerDraftStore } from "../composerDraftStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { THREAD_TERMINAL_SURFACE_ID, type LayoutTab } from "./layoutModel";
import type { LayoutTabLabel } from "./PaneTabBar";
import { surfaceTabTitle } from "./surfaceTabLabels";

const NEW_THREAD_TITLE = "New thread";

const PAGE_TITLES = {
  "pull-requests": "Pull requests",
  issues: "Issues",
  tasks: "Tasks",
} as const;

/** Each page tab carries its own icon, the one its launcher row shows. */
const PAGE_ICONS: Record<keyof typeof PAGE_TITLES, LucideIcon> = {
  "pull-requests": PullRequestGlyph.pullRequest,
  issues: CircleDotIcon,
  tasks: ListChecksIcon,
};

function iconOf(Icon: LucideIcon) {
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

function surfaceIcon(kind: string): LucideIcon {
  switch (kind) {
    case "diff":
      return GitCompareIcon;
    case "files":
      return FolderTreeIcon;
    case "file":
      return FileIcon;
    case "preview":
      return GlobeIcon;
    case "device":
      return SmartphoneIcon;
    case "terminal":
      return SquareTerminalIcon;
    case "issue":
      return CircleDotIcon;
    case "task":
      return ListChecksIcon;
    default:
      return SquareDashedIcon;
  }
}

/**
 * A chat tab's icon. A thread that has run at least once shows the mark of the provider it runs
 * on, as its sidebar card does. Before its first run the provider is only a default, so a draft
 * or an unsent thread shows the new-thread glyph; so does a provider this client does not know.
 */
export function ChatTabIcon({
  shell,
  providerEntries,
}: {
  readonly shell: EnvironmentThreadShell | null;
  readonly providerEntries: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const mark =
    shell === null || shell.latestRun === null ? null : (
      <SidebarProviderStack thread={shell} providerEntryByInstanceId={providerEntries} quiet />
    );
  return (
    <span data-chat-tab-icon="" className="inline-grid size-3.5 shrink-0 place-items-center">
      {mark}
      <SquarePenIcon aria-hidden className="size-3.5 not-only:hidden" />
    </span>
  );
}

/** A draft names its project so tabs of different projects stay apart. A scratch draft does not. */
function draftTabTitle(
  session: DraftThreadState | undefined,
  projects: ReadonlyArray<EnvironmentProject>,
): string | null {
  if (!session) return null;
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === session.environmentId && candidate.id === session.projectId,
  );
  if (!project || project.isScratch === true) return null;
  return `${NEW_THREAD_TITLE} · ${project.title}`;
}

/**
 * The label of every tab, from the thread and surface state it shows. The tab bar calls the
 * returned function once per tab while it renders, so the stores it reads are subscribed here.
 */
export function useLayoutTabLabel(): (tab: LayoutTab) => LayoutTabLabel {
  const shells = useQuietThreadShells();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const panels = useRightPanelStore((state) => state.byThreadKey);
  const draftSessions = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const projects = useProjects();
  const shellByKey = new Map(
    shells.map(
      (shell) => [scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id)), shell] as const,
    ),
  );
  return (tab) => {
    const content = tab.content;
    switch (content.kind) {
      case "chat": {
        const ref = chatTargetThreadRef(content.target);
        const shell = ref === null ? null : (shellByKey.get(scopedThreadKey(ref)) ?? null);
        const draftTitle =
          shell === null && content.target.kind === "draft"
            ? draftTabTitle(draftSessions[content.target.draftId], projects)
            : null;
        return {
          icon: (
            <ChatTabIcon
              shell={shell}
              providerEntries={
                (shell === null
                  ? undefined
                  : providerEntriesByEnvironment.get(shell.environmentId)) ?? EMPTY_PROVIDER_ENTRIES
              }
            />
          ),
          title: shell?.title || draftTitle || NEW_THREAD_TITLE,
          ...(draftTitle === null ? {} : { tooltip: draftTitle }),
        };
      }
      case "surface": {
        const shell = shellByKey.get(scopedThreadKey(content.threadRef)) ?? null;
        const owner = shell?.title || NEW_THREAD_TITLE;
        if (content.surfaceId === THREAD_TERMINAL_SURFACE_ID) {
          return {
            icon: iconOf(SquareTerminalIcon),
            title: "Terminal",
            tooltip: `Terminal · ${owner}`,
          };
        }
        const surface = selectThreadRightPanelState(panels, content.threadRef).surfaces.find(
          (entry) => entry.id === content.surfaceId,
        );
        if (surface === undefined) {
          return { icon: iconOf(SquareDashedIcon), title: "Closed", tooltip: owner };
        }
        const title = surfaceTabTitle(surface, null);
        return {
          icon: iconOf(surfaceIcon(surface.kind)),
          title,
          tooltip: `${title} · ${owner}`,
        };
      }
      case "launcher":
        return { icon: iconOf(SquareDashedIcon), title: "New tab" };
      case "pull-requests":
      case "issues":
      case "tasks":
        return {
          icon: iconOf(PAGE_ICONS[content.kind]),
          title: PAGE_TITLES[content.kind],
        };
    }
  };
}
