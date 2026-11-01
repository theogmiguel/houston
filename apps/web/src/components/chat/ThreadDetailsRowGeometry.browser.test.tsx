import { StrictMode, type ReactNode } from "react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { PopoverCreateHandle } from "../ui/popover";
import { Switch } from "../ui/switch";
import {
  ThreadDetailsRow,
  ThreadDetailsRowButton,
  ThreadDetailsRowContent,
  ThreadDetailsRowLabelButton,
} from "../ui/thread-details-row";
import { useRightPanelStore } from "../../rightPanelStore";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-geometry"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 848, y: 0, right: 12, width: 340, height: 800 } as const;

const row = (content: ReactNode) => (
  <ThreadDetailsRow data-thread-details-row="">{content}</ThreadDetailsRow>
);

function Card() {
  const anchor = { current: document.createElement("div") };
  return (
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: placement,
        }}
      >
        <ThreadDetailsCard
          threadRef={threadRef}
          anchor={anchor}
          handle={PopoverCreateHandle()}
          contentKey="geometry"
        >
          {() => (
            <>
              <ThreadDetailsSection
                headingId="geometry-workspace"
                title="Workspace"
                separated={false}
              >
                <ThreadDetailsControl part="select" data-thread-details-row="">
                  <span className="min-w-0 truncate">This computer</span>
                </ThreadDetailsControl>
                <ThreadDetailsControl part="select" data-thread-details-row="">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">Worktree</span>
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      split-drawer
                    </span>
                  </span>
                </ThreadDetailsControl>
                <ThreadDetailsRow>
                  <ThreadDetailsRowLabelButton className="col-start-1">
                    Open in VS Code
                  </ThreadDetailsRowLabelButton>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="col-start-2 px-0"
                    aria-label="Choose editor"
                  >
                    <Kbd>Ctrl O</Kbd>
                  </Button>
                </ThreadDetailsRow>
                <ThreadDetailsRow>
                  <ThreadDetailsRowLabelButton className="col-start-1">
                    Scripts
                  </ThreadDetailsRowLabelButton>
                  <span className="col-start-2 flex min-w-0 flex-wrap items-center justify-end gap-1">
                    <Button type="button" variant="secondary" size="sm">
                      Dev
                    </Button>
                    <Button type="button" variant="secondary" size="sm">
                      Test
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon-sm"
                      aria-label="Add project script"
                    >
                      <PlusIcon className="size-3" />
                    </Button>
                  </span>
                </ThreadDetailsRow>
              </ThreadDetailsSection>
              <ThreadDetailsSection headingId="geometry-version-control" title="Version control">
                <ThreadDetailsRowButton>
                  <ThreadDetailsRowContent
                    label="Changes"
                    value="4 files"
                    right={
                      <span className="flex items-center gap-1.5 text-xs tabular-nums">
                        <span className="text-diff-addition-foreground">+128</span>
                        <span className="text-diff-deletion-foreground">-41</span>
                      </span>
                    }
                  />
                </ThreadDetailsRowButton>
                <div
                  data-thread-details-row=""
                  data-thread-details-actions=""
                  className="flex min-h-7 flex-wrap items-center gap-1.5 px-2 py-0.5"
                >
                  <Button type="button" variant="outline" size="sm">
                    Commit
                  </Button>
                  <Button type="button" variant="outline" size="sm">
                    Push
                  </Button>
                  <Button type="button" variant="ghost" size="sm">
                    Create PR
                  </Button>
                </div>
              </ThreadDetailsSection>
              <ThreadDetailsSection headingId="geometry-servers" title="Servers">
                {row(
                  <ThreadDetailsRowContent
                    label="localhost:5173"
                    value="vite"
                    right={
                      <>
                        <span className="size-1.5 rounded-full bg-success" aria-hidden />
                        Running
                      </>
                    }
                  />,
                )}
              </ThreadDetailsSection>
              <ThreadDetailsSection headingId="geometry-automations" title="Automations">
                <ul className="m-0 list-none p-0">
                  <li
                    data-thread-details-row=""
                    className="flex min-h-7 items-center gap-2 rounded-md px-2 py-0.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-body text-foreground">
                      Auto-close on merge
                    </span>
                    <Switch size="sm" checked aria-label="Pause Auto-close on merge" />
                  </li>
                </ul>
              </ThreadDetailsSection>
            </>
          )}
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>
  );
}

it("keeps every details row on a 28px rhythm with shared label and right edges", async () => {
  useRightPanelStore.setState({
    threadPanelVisibilityByThreadKey: {},
    threadPanelPresentationByThreadKey: {},
  });
  await using _screen = await render(<Card />, { router: false });
  await expect.element(page.getByRole("region", { name: "Thread details" })).toBeVisible();

  const rows = [...document.querySelectorAll<HTMLElement>("[data-thread-details-row]")];
  expect(rows.length).toBe(8);

  for (const row of rows) {
    expect({
      height: Math.round(row.getBoundingClientRect().height),
      row: row.textContent,
    }).toEqual({ height: 28, row: row.textContent });
  }

  const labelLeft = (row: HTMLElement) => {
    const label =
      row.querySelector<HTMLElement>('[data-slot="select-label"] > span') ?? row.firstElementChild;
    if (label === null) return null;
    return Math.round(label.getBoundingClientRect().left);
  };
  const rightEdge = (row: HTMLElement) => {
    if (row.hasAttribute("data-thread-details-actions")) return null;
    const right =
      row.querySelector<HTMLElement>('[data-slot="select-icon"] > svg') ??
      row.querySelector<HTMLElement>('[data-slot="switch"]') ??
      row.lastElementChild;
    if (right === null) return null;
    return Math.round(right.getBoundingClientRect().right);
  };

  const labelLefts = rows.map(labelLeft).filter((left) => left !== null);
  const rightEdges = rows.map(rightEdge).filter((right) => right !== null);
  expect(labelLefts).toHaveLength(8);
  expect(rightEdges).toHaveLength(7);
  expect(new Set(labelLefts).size).toBe(1);
  expect(new Set(rightEdges).size).toBe(1);
});
