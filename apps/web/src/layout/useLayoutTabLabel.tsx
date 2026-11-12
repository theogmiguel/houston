import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import {
  ChartNoAxesColumnIcon,
  FileIcon,
  FolderIcon,
  GitCompareIcon,
  GlobeIcon,
  MessageSquareIcon,
  SettingsIcon,
  SmartphoneIcon,
  SquareDashedIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { resolveGridThreadState } from "../grid/sidebar";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShells } from "../state/entities";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { THREAD_TERMINAL_SURFACE_ID, type LayoutTab } from "./layoutModel";
import type { LayoutTabLabel } from "./PaneTabBar";
import { surfaceTabTitle } from "./surfaceTabLabels";

const NEW_THREAD_TITLE = "New thread";

const PAGE_TITLES = {
  settings: "Settings",
  usage: "Usage",
  "pull-requests": "Pull requests",
} as const;

function iconOf(Icon: LucideIcon) {
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

function surfaceIcon(kind: string): LucideIcon {
  switch (kind) {
    case "diff":
      return GitCompareIcon;
    case "files":
      return FolderIcon;
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

/** The status a thread's tab marks: work running, or something that needs the person. */
function markOf(shell: EnvironmentThreadShell | null, nowIso: string): LayoutTabLabel["mark"] {
  if (shell === null) return undefined;
  const state = resolveGridThreadState(shell, nowIso);
  if (state === "running") return "running";
  return state === "needs" || state === "failed" ? "attention" : undefined;
}

/**
 * The label of every tab, from the thread and surface state it shows. The tab bar calls the
 * returned function once per tab while it renders, so the stores it reads are subscribed here.
 */
export function useLayoutTabLabel(): (tab: LayoutTab) => LayoutTabLabel {
  const shells = useQuietThreadShells();
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
          icon: iconOf(MessageSquareIcon),
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
      case "usage":
      case "pull-requests":
        return {
          icon: iconOf(content.kind === "settings" ? SettingsIcon : ChartNoAxesColumnIcon),
          title: PAGE_TITLES[content.kind],
        };
    }
  };
}
