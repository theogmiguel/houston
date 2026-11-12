import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: async () => {}, closeMenu: () => {} }),
}));
vi.mock(import("../sidebar/ThreadRowPullRequestBadge"), () => ({
  ThreadRowPullRequestBadge: (props: {
    pullRequest: { number: number };
    pullRequestCount: number;
  }) => (
    <span data-testid="header-pr-badge">
      #{props.pullRequest.number}
      {props.pullRequestCount > 1 ? ` +${props.pullRequestCount - 1}` : ""}
    </span>
  ),
}));

import "~/index.css";
import type { ReactNode } from "react";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ChatHeader } from "./ChatHeader";

const LONG_TITLE =
  "Investigate intermittent ECONNRESET errors on the /v1/webhooks/ingest endpoint when payloads exceed 1 MB behind the load balancer";

const PULL_REQUEST = {
  number: 42,
  url: "https://github.com/acme/atlas-api/pull/42",
  state: "open",
  title: "Add retry hints",
  checksState: null,
} as const;

function header(
  title: string,
  options: {
    width?: number;
    project?: boolean;
    projectName?: string;
    pullRequest?: boolean;
    onOpenThread?: (threadId: ThreadId) => void;
    children?: ReactNode;
  } = {},
) {
  const width = options.width ?? 1440;
  return (
    <TooltipProvider delay={0}>
      <div style={{ width }} className="flex items-center gap-2 px-3">
        <ChatHeader
          activeThreadEnvironmentId={EnvironmentId.make("environment")}
          activeThreadId={ThreadId.make("thread")}
          activeThreadTitle={title}
          isServerThread
          activeProject={
            options.project === false
              ? null
              : ({ title: options.projectName ?? "atlas-api", isScratch: false } as never)
          }
          parentThreadLink={null}
          pullRequest={options.pullRequest === false ? null : PULL_REQUEST}
          pullRequestCount={1}
          onOpenThread={options.onOpenThread ?? (() => {})}
        />
        <div data-testid="toolbar" className="ms-auto flex shrink-0 gap-1">
          <button type="button" className="size-7">
            A
          </button>
          <button type="button" className="size-7">
            B
          </button>
        </div>
        {options.children}
        <div tabIndex={0}>Outside rename</div>
      </div>
    </TooltipProvider>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("sets the project segment in muted ink and the thread title at 14px medium weight", async () => {
  await using screen = await render(header("Add a retry-after hint"));

  const project = getComputedStyle(screen.getByText("atlas-api").element());
  const title = getComputedStyle(screen.getByRole("heading", { level: 2 }).element());
  expect(project.fontWeight).toBe("400");
  expect(title.fontWeight).toBe("500");
  expect(title.fontSize).toBe("14px");
});

it.each([
  [1440, false],
  [800, true],
])(
  "keeps the header on one line with a %ipx thread title that truncates when needed",
  async (width, truncates) => {
    await using screen = await render(header(LONG_TITLE, { width }));

    const heading = screen.getByRole("heading", { level: 2 }).element() as HTMLElement;
    const titleStyle = getComputedStyle(heading);
    expect(heading.textContent).toBe(LONG_TITLE);
    expect(titleStyle.webkitLineClamp).toBe("none");
    expect(titleStyle.textOverflow).toBe("ellipsis");
    expect(titleStyle.whiteSpace).toBe("nowrap");
    if (truncates) expect(heading.scrollWidth).toBeGreaterThan(heading.clientWidth);
    const lineHeight = Number.parseFloat(titleStyle.lineHeight);
    expect(heading.getBoundingClientRect().height).toBeLessThan(lineHeight + 4);
    expect(
      screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` }).element(),
    ).toBeTruthy();
  },
);

it("shows the full thread title in a tooltip, including a long one", async () => {
  await using screen = await render(header(LONG_TITLE, { width: 800 }));
  const trigger = screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` });
  await userEvent.hover(trigger);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(LONG_TITLE),
  );
});

it("renders no meta row and puts the pull request badge after the title", async () => {
  await using screen = await render(header("Add a retry-after hint"));

  expect(document.querySelector("[data-thread-header-meta]")).toBeNull();
  const title = screen.getByRole("heading", { level: 2 }).element();
  const badge = screen.getByTestId("header-pr-badge").element();
  expect(badge.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    title.getBoundingClientRect().right,
  );
});

it.each([1440, 800])(
  "keeps the project name, capped at 120px with an ellipsis, in a %ipx header",
  async (width) => {
    await using screen = await render(
      header("Add a retry-after hint", {
        width,
        projectName: "atlas-api-with-a-very-long-service-name",
      }),
    );
    const group = screen.container.querySelector<HTMLElement>("[data-thread-project]")!;
    const name = [...group.querySelectorAll("span")].find(
      (span) =>
        span.textContent === "atlas-api-with-a-very-long-service-name" &&
        span.children.length === 0,
    )!;
    const rect = name.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.width).toBeLessThanOrEqual(120);
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(group.querySelector("svg")).not.toBeNull();
    expect(group.textContent).toContain("/");
  },
);

it("shows only a folder icon under 600px of header width, with the project in the tooltip and the accessible name", async () => {
  await using screen = await render(header("Add a retry-after hint", { width: 560 }));
  const group = screen.container.querySelector<HTMLElement>("[data-thread-project]")!;
  const name = [...group.querySelectorAll("span")].find(
    (span) => span.textContent === "atlas-api" && span.children.length === 0,
  )!;
  // Nothing but the icon is painted: the name is visually hidden and the separator is gone.
  expect(group.querySelector("svg")).not.toBeNull();
  expect(name.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  expect(
    [...group.querySelectorAll("span")]
      .filter((span) => span.getBoundingClientRect().width > 1)
      .map((span) => span.textContent)
      .join(""),
  ).not.toContain("/");
  await screen.getByRole("button", { name: /Thread actions for/ }).hover();
  await userEvent.hover(group.querySelector("svg")!);
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll('[data-slot="tooltip-popup"]')].some(
        (popup) => popup.textContent === "atlas-api",
      ),
    ).toBe(true),
  );
});

it("keeps the parent thread and its keyboard path reachable in the single line", async () => {
  const onOpenThread = vi.fn();
  const parentTitle = "Coordinate the 0.3 ledger migration";
  await using screen = await render(
    <TooltipProvider delay={0}>
      <div style={{ width: 1440 }} className="flex items-center gap-2 px-3">
        <ChatHeader
          activeThreadEnvironmentId={EnvironmentId.make("environment")}
          activeThreadId={ThreadId.make("thread")}
          activeThreadTitle="Add a retry-after hint"
          isServerThread
          activeProject={{ title: "atlas-api", isScratch: false } as never}
          parentThreadLink={{ threadId: ThreadId.make("parent"), title: parentTitle }}
          pullRequest={PULL_REQUEST}
          pullRequestCount={1}
          onOpenThread={onOpenThread}
        />
      </div>
    </TooltipProvider>,
  );

  await screen.getByRole("button", { name: `Open parent thread: ${parentTitle}` }).click();
  expect(onOpenThread).toHaveBeenCalledWith(ThreadId.make("parent"));
});
