import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@houston-app/contracts";

import type { AddProjectFlowRequest } from "./addProjectFlow";
import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  /** With new-thread-in, the thread opens in a new tab of the focused pane, not in place. */
  readonly newTab?: boolean;
  /** With add-project, the flow to start and the environment or source it starts from. */
  readonly addProject?: AddProjectFlowRequest;
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
}

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({
      _tag: "OpenNewThreadIn",
      ...(detail.newTab === true ? { newTab: true } : {}),
    });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({
      _tag: "OpenAddProject",
      ...(detail.addProject === undefined ? {} : { request: detail.addProject }),
    });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
