import type { OrchestrationV2PendingBackgroundTask, ThreadId } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";
import { IN_TURN_GAP_ABOVE_CLASS } from "./timelineSpacing";

const THREAD_ID = "thread-parent" as ThreadId;
const capturesEnabled = import.meta.env.VITE_HOUSTON_CAPTURES === "1";
const SHOT_DIR = (import.meta.env.VITE_THREAD_NOW_SHOT_NAME as string | undefined) ?? "thread-now";

function subagent(index: number, description: string): OrchestrationV2PendingBackgroundTask {
  return { kind: "subagent", taskId: `task-${index}`, description, awaited: true };
}

const THREE_SUBAGENTS = [
  subagent(1, "UI feedback A: composer + model picker"),
  subagent(2, "UI feedback B: header, Tidy, panel title, rail counts"),
  subagent(3, "UI feedback C: timeline rows"),
];

function work(tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) {
  return backgroundWorkNowItem({
    threadId: THREAD_ID,
    tasks,
    turnItems: [],
    stopDisabled: false,
    stopping: false,
    onStop: async () => undefined,
    onOpenThread: () => undefined,
  });
}

function mount(tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) {
  return render(
    <div data-testid="lane" className="w-[880px] bg-background">
      <div data-testid="footer" className="h-6 text-xs">
        Claude · Opus 5.5 0:49
      </div>
      <ThreadNow attention={null} work={work(tasks)} syncPhase={null} goal={null} />
    </div>,
    { router: false },
  );
}

function line(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-thread-now-line]");
  if (!element) throw new Error("ThreadNow line is not rendered");
  return element;
}

it("leaves the in-turn gap above the row", async () => {
  await using screen = await mount(THREE_SUBAGENTS);
  const row = line(screen.container);
  expect(IN_TURN_GAP_ABOVE_CLASS).toBe("pt-3");
  expect(parseFloat(getComputedStyle(row).paddingTop)).toBe(12);
});

it("titles several subagents without joining their names", async () => {
  await using screen = await mount(THREE_SUBAGENTS);
  const text = line(screen.container).textContent ?? "";
  expect(text).toContain("Waiting on 3 subagents");
  expect(text).not.toContain("UI feedback A");
  expect(text).not.toContain("UI feedback B");
});

it("lists each child on its own line behind the details button", async () => {
  await using _screen = await mount(THREE_SUBAGENTS);
  await userEvent.click(page.getByRole("button", { name: /Show details/ }));
  const items = Array.from(document.querySelectorAll<HTMLElement>("[data-thread-now-detail]"));
  expect(items.map((item) => item.textContent)).toEqual([
    "UI feedback A: composer + model picker",
    "UI feedback B: header, Tidy, panel title, rail counts",
    "UI feedback C: timeline rows",
  ]);
  const tops = items.map((item) => item.getBoundingClientRect().top);
  expect(new Set(tops).size).toBe(3);
});

it("keeps a single task as one line with its own details", async () => {
  await using screen = await mount([subagent(1, "UI feedback A: composer")]);
  const text = line(screen.container).textContent ?? "";
  expect(text).toContain("Waiting on");
  expect(text).toContain("UI feedback A: composer");
  expect(text).toContain("Stop");
  expect(document.querySelector("[data-thread-now-detail]")).toBeNull();
});

it("keeps the details button and Stop on the text's line", async () => {
  await using screen = await mount(THREE_SUBAGENTS);
  const row = line(screen.container);
  const title = row.querySelector<HTMLElement>("[data-thread-now-title]");
  const details = page.getByRole("button", { name: /Show details/ }).element();
  const stop = page.getByRole("button", { name: "Stop" }).element();
  if (!title) throw new Error("title is not rendered");
  const mid = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.top + rect.height / 2;
  };
  expect(Math.abs(mid(details) - mid(title))).toBeLessThanOrEqual(1);
  expect(Math.abs(mid(stop) - mid(title))).toBeLessThanOrEqual(1.5);
  const gaps = [
    details.getBoundingClientRect().left - title.getBoundingClientRect().right,
    stop.getBoundingClientRect().left - details.getBoundingClientRect().right,
  ];
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(12);
});

it.skipIf(!capturesEnabled)("captures three subagents in both themes", async () => {
  for (const theme of ["dark", "light"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await using screen = await mount(THREE_SUBAGENTS);
    await page.screenshot({
      element: screen.getByTestId("lane").element(),
      path: `../../../../../.slice/captures/${SHOT_DIR}-${theme}.png`,
    });
  }
  document.documentElement.classList.remove("dark");
});
