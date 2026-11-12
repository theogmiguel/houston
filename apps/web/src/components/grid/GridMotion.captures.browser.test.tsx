import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { beginThreadDragAt, endThreadDrag, type ThreadDragSource } from "../../threads/threadDrag";
import type { GridRecord } from "../../grid/gridStore";
import { threadLeaf, type LayoutNode, type Side } from "@houston-app/shared/grid/tree";
import { act, render } from "../../../test/render";
import { configureMotion } from "../../motion/registry";
import { GridHost, type GridCellRenderProps } from "./GridHost";
import { GridDropIndicator } from "../ui/grid-drop-indicator";

const capturesEnabled = import.meta.env.VITE_HOUSTON_CAPTURES === "1";

const TITLES = ["Sidebar feedback", "Port grid motion", "Cold launch fix"];

function tree(...threadIds: string[]): LayoutNode {
  return {
    kind: "split",
    dir: "row",
    children: threadIds.map((threadId) => threadLeaf(threadId, `p-${threadId}`)),
    weights: threadIds.map(() => 100 / threadIds.length),
  };
}

function grid(node: LayoutNode): GridRecord {
  return {
    id: "g-capture",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: node,
    focusedThreadId: "t-1",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function Cell({ cell }: { cell: GridCellRenderProps }) {
  const index = Number(cell.node.threadId.replace("t-", "")) - 1;
  const title = TITLES[index] ?? `Thread ${cell.node.threadId}`;
  return (
    <section
      data-grid-cell=""
      data-thread-id={cell.node.threadId}
      className="relative flex h-full w-full flex-col overflow-hidden"
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-(--divider) px-3">
        <span className="size-2 rounded-full bg-(--accent-ink)" />
        <span className="truncate text-xs font-semibold">{title}</span>
        <span className="ml-auto text-xs text-muted-foreground">10m</span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="h-2 w-2/3 rounded-full bg-(--raised)" />
        <div className="h-2 w-4/5 rounded-full bg-(--raised)" />
        <div className="h-2 w-1/2 rounded-full bg-(--raised)" />
      </div>
      <div className="m-2.5 h-8 rounded-(--r-ctl) border border-(--divider) bg-(--raised)" />
      {cell.dropRefusal !== null ? (
        <GridDropIndicator refusal={cell.dropRefusal} />
      ) : cell.dropIndicator === null ? null : (
        <GridDropIndicator side={cell.dropIndicator} />
      )}
    </section>
  );
}

async function mountGrid(node: LayoutNode) {
  return render(
    <div
      data-capture-frame=""
      className="relative flex h-[560px] w-full flex-col overflow-hidden bg-(--background)"
    >
      <GridHost
        grid={grid(node)}
        onTreeChange={() => {}}
        onFocusThread={() => {}}
        renderThread={(cell) => <Cell cell={cell} />}
      />
    </div>,
    { router: false },
  );
}

function gutter(container: HTMLElement, index = 0): HTMLElement {
  const found = container.querySelectorAll<HTMLElement>("[data-grid-gutter]")[index];
  if (found == null) throw new Error(`missing divider ${index}`);
  return found;
}

async function startResize(container: HTMLElement): Promise<void> {
  const divider = gutter(container);
  const rect = divider.getBoundingClientRect();
  const pointer = { bubbles: true, pointerId: 1, button: 0 };
  const y = rect.top + rect.height / 2;
  const x = rect.left + rect.width / 2;
  divider.setPointerCapture = () => undefined;
  await act(() => {
    divider.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: x, clientY: y }));
  });
  await act(() => {
    divider.dispatchEvent(
      new PointerEvent("pointermove", { ...pointer, clientX: x - 10, clientY: y }),
    );
  });
  const badge = container.querySelector<HTMLElement>("[data-grid-resize-badge]");
  if (badge !== null) await vi.waitFor(() => expect(badge.style.display).toBe("inline-block"));
}

async function hoverZone(
  container: HTMLElement,
  threadId: string,
  side: Side,
  source: ThreadDragSource,
): Promise<void> {
  const cell = container.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
  if (cell === null) throw new Error(`missing cell ${threadId}`);
  const rect = cell.getBoundingClientRect();
  const point =
    side === "center"
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : side === "left"
        ? { x: rect.left + rect.width * 0.1, y: rect.top + rect.height / 2 }
        : { x: rect.left + rect.width * 0.9, y: rect.top + rect.height / 2 };
  await act(() => beginThreadDragAt(source, point));
}

const OWNER = { environmentId: "env-1", projectId: "project-1" } as const;

const SAME_GRID_SOURCE: ThreadDragSource = {
  gridId: "g-other",
  threadId: "t-9",
  ...OWNER,
};

const OTHER_PROJECT_SOURCE: ThreadDragSource = {
  gridId: "g-other",
  threadId: "t-9",
  environmentId: "env-1",
  projectId: "project-2",
};

function captureGuard() {
  return {
    [Symbol.dispose]: () => {
      endThreadDrag();
      configureMotion({ off: false });
      document.documentElement.classList.remove("dark");
    },
  };
}

const CAPTURE_CASES = (["light", "dark"] as const).flatMap((theme) =>
  [
    { name: "default", px: 1100 },
    { name: "narrow", px: 640 },
  ].map((width) => ({ theme, width })),
);

describe.skipIf(!capturesEnabled)("grid motion captures", () => {
  it.each(CAPTURE_CASES)(
    "captures the grid states in $theme at $width.name width",
    async ({ theme, width }) => {
      using _capture = captureGuard();
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.viewport(width.px, 640);
      const path = `../../../../../.slice/captures`;

      await using resizing = await mountGrid(tree("t-1", "t-2", "t-3"));
      await startResize(resizing.container);
      expect(
        resizing.container.querySelector<HTMLElement>("[data-grid-resize-badge]")?.style.display,
      ).toBe("inline-block");
      await page.screenshot({
        element: resizing.container,
        path: `${path}/resize-badge-${theme}-${width.name}.png`,
      });

      await using edge = await mountGrid(tree("t-1", "t-2", "t-3"));
      await hoverZone(edge.container, "t-3", "right", SAME_GRID_SOURCE);
      await page.screenshot({
        element: edge.container,
        path: `${path}/drop-edge-${theme}-${width.name}.png`,
      });

      await using center = await mountGrid(tree("t-1", "t-2", "t-3"));
      await hoverZone(center.container, "t-2", "center", SAME_GRID_SOURCE);
      await page.screenshot({
        element: center.container,
        path: `${path}/drop-center-${theme}-${width.name}.png`,
      });

      await using refusal = await mountGrid(tree("t-1", "t-2", "t-3"));
      await hoverZone(refusal.container, "t-2", "center", OTHER_PROJECT_SOURCE);
      await page.screenshot({
        element: refusal.container,
        path: `${path}/refusal-project-${theme}-${width.name}.png`,
      });
      endThreadDrag();

      await using full = await mountGrid(tree("t-1", "t-2", "t-3", "t-4", "t-5", "t-6"));
      await hoverZone(full.container, "t-6", "right", SAME_GRID_SOURCE);
      await page.screenshot({
        element: full.container,
        path: `${path}/refusal-full-${theme}-${width.name}.png`,
      });
      endThreadDrag();

      configureMotion({ off: true });
      await using reduced = await mountGrid(tree("t-1", "t-2", "t-3"));
      await startResize(reduced.container);
      await page.screenshot({
        element: reduced.container,
        path: `${path}/reduced-motion-${theme}-${width.name}.png`,
      });
    },
  );
});
