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
vi.mock(import("../grid/ThreadRowPullRequestBadge"), () => ({
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
import { ChatHeader, type ChatHeaderMeta } from "./ChatHeader";

const LONG_TITLE =
  "Investigate intermittent ECONNRESET errors on the /v1/webhooks/ingest endpoint when payloads exceed 1 MB behind the load balancer";

function fullMeta(overrides: Partial<ChatHeaderMeta> = {}): ChatHeaderMeta {
  return {
    branch: "main",
    checkoutLabel: "Local checkout",
    status: { label: "Running", state: "running" },
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/atlas-api/pull/42",
      state: "open",
      title: "Add retry hints",
      checksState: null,
    },
    pullRequestCount: 1,
    diffTotals: { insertions: 37, deletions: 3 },
    providerLabel: "Claude",
    modelLabel: "Opus 5.5",
    onOpenChanges: () => {},
    ...overrides,
  };
}

function header(
  title: string,
  options: {
    width?: number;
    meta?: ChatHeaderMeta | undefined;
    project?: boolean;
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
            options.project === false ? null : ({ title: "atlas-api", isScratch: false } as never)
          }
          parentThreadLink={null}
          meta={options.meta}
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

it("sets the project segment in muted ink and the thread title in semibold foreground", async () => {
  await using screen = await render(header("Add a retry-after hint", { meta: fullMeta() }));

  const project = getComputedStyle(screen.getByText("atlas-api").element());
  const title = getComputedStyle(screen.getByRole("heading", { level: 2 }).element());
  expect(project.fontWeight).toBe("400");
  expect(title.fontWeight).toBe("600");
  expect(project.color).not.toBe(title.color);
});

it.each([
  [1440, 1],
  [800, 2],
])(
  "shows a %ipx thread title in full, on at most two lines when the header is narrow",
  async (width, expectedLines) => {
    await using screen = await render(header(LONG_TITLE, { width, meta: fullMeta() }));

    const heading = screen.getByRole("heading", { level: 2 }).element() as HTMLElement;
    expect(heading.textContent).toBe(LONG_TITLE);
    expect(getComputedStyle(heading).webkitLineClamp).toBe("2");
    const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);
    const lines = Math.round(heading.getBoundingClientRect().height / lineHeight);
    expect(lines).toBe(expectedLines);
    expect(
      screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` }).element(),
    ).toBeTruthy();
  },
);

it("shows the full thread title in a tooltip, including a long one", async () => {
  await using screen = await render(header(LONG_TITLE, { width: 800, meta: fullMeta() }));
  const trigger = screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` });
  await userEvent.hover(trigger);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(LONG_TITLE),
  );
});

it.each([1440, 800])(
  "orders the meta row and opens the changes panel from the diff totals in a %ipx header",
  async (width) => {
    const onOpenChanges = vi.fn();
    await using screen = await render(
      header("Add a retry-after hint", {
        width,
        meta: fullMeta({ onOpenChanges }),
      }),
    );

    const content = document
      .querySelector<HTMLElement>("[data-thread-header-meta]")!
      .textContent?.replaceAll(/\s+/g, " ");
    expect(content).toMatch(
      /atlas-api.*main.*Local checkout.*Running.*#42.*\+37.*-3.*Claude.*Opus 5\.5/,
    );

    await screen.getByRole("button", { name: "Open changes: 37 additions, 3 deletions" }).click();
    expect(onOpenChanges).toHaveBeenCalledOnce();
  },
);

it("keeps project, branch, status, diff and provider in the meta row and clears the toolbar", async () => {
  await using screen = await render(header(LONG_TITLE, { width: 800, meta: fullMeta() }));

  const meta = document.querySelector<HTMLElement>("[data-thread-header-meta]")!;
  const title = screen.getByRole("heading", { level: 2 }).element();
  const toolbar = screen.getByTestId("toolbar").element();
  expect(meta.getBoundingClientRect().top).toBeGreaterThan(title.getBoundingClientRect().bottom);
  expect(toolbar.getBoundingClientRect().left).toBeGreaterThan(
    title.getBoundingClientRect().right + 16,
  );
});

it("keeps the parent thread and its keyboard path reachable from the meta row", async () => {
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
          meta={fullMeta()}
          onOpenThread={onOpenThread}
        />
      </div>
    </TooltipProvider>,
  );

  await screen.getByRole("button", { name: `Open parent thread: ${parentTitle}` }).click();
  expect(onOpenThread).toHaveBeenCalledWith(ThreadId.make("parent"));
});
