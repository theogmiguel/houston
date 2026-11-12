import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import {
  ListChecksIcon,
  FileIcon,
  FolderTreeIcon,
  GitCompareIcon,
  GlobeIcon,
  SettingsIcon,
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
import { useNowMinute } from "../hooks/useNowMinute";
import { resolveThreadRowState } from "../threads/sidebarModel";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShells } from "../state/entities";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { THREAD_TERMINAL_SURFACE_ID, type LayoutTab } from "./layoutModel";
import type { LayoutTabLabel } from "./PaneTabBar";
import { surfaceTabTitle } from "./surfaceTabLabels";

const NEW_THREAD_TITLE = "New thread";

const PAGE_TITLES = {
  settings: "Settings",
  "pull-requests": "Pull requests",
  tasks: "Tasks",
} as const;

/** Each page tab carries its own icon, the one its sidebar footer and launcher row show. */
const PAGE_ICONS: Record<keyof typeof PAGE_TITLES, LucideIcon> = {
  settings: SettingsIcon,
  "pull-requests": PullRequestGlyph.pullRequest,
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

/** The status a thread's tab marks: work running, or something that needs the person. */
function markOf(shell: EnvironmentThreadShell | null, nowIso: string): LayoutTabLabel["mark"] {
  if (shell === null) return undefined;
  const state = resolveThreadRowState(shell, nowIso);
  if (state === "running") return "running";
  return state === "needs" || state === "failed" ? "attention" : undefined;
}

/**
 * The label of every tab, from the thread and surface state it shows. The tab bar calls the
 * returned function once per tab while it renders, so the stores it reads are subscribed here.
 */
export function useLayoutTabLabel(): (tab: LayoutTab) => LayoutTabLabel {
  const shells = useQuietThreadShells();
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const panels = useRightPanelStore((state) => state.byThreadKey);
  const nowMinute = useNowMinute();
  const nowIso = `${nowMinute}:00.000Z`;
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
          title: shell?.title || NEW_THREAD_TITLE,
          mark: markOf(shell, nowIso),
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
      case "settings":
      case "pull-requests":
      case "tasks":
        return {
          icon: iconOf(PAGE_ICONS[content.kind]),
          title: PAGE_TITLES[content.kind],
        };
    }
  };
}
