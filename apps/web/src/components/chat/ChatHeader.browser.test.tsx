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

import "~/index.css";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ChatHeader } from "./ChatHeader";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
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

it("sets the project segment in regular muted ink and the thread title in medium foreground", async () => {
  await using screen = await render(
    <ChatHeader
      activeThreadEnvironmentId={EnvironmentId.make("environment")}
      activeThreadId={ThreadId.make("thread")}
      activeThreadTitle="Add a retry-after hint"
      isServerThread
      activeProject={{ title: "atlas-api", isScratch: false } as never}
      parentThreadLink={null}
      onOpenThread={() => {}}
    />,
  );

  const project = getComputedStyle(screen.getByText("atlas-api").element());
  const title = getComputedStyle(screen.getByRole("heading", { level: 2 }).element());
  expect(project.fontWeight).toBe("400");
  expect(title.fontWeight).toBe("500");
  expect(project.color).not.toBe(title.color);
});

it.each([640, 1100])(
  "truncates a long thread title with an ellipsis in a %ipx header, clear of the toolbar",
  async (headerWidth) => {
    const longTitle =
      "Investigate intermittent ECONNRESET errors on the /v1/webhooks/ingest endpoint when payloads exceed 1 MB behind the load balancer";
    await using screen = await render(
      <div style={{ width: headerWidth }} className="flex items-center gap-2 px-3">
        <ChatHeader
          activeThreadEnvironmentId={EnvironmentId.make("environment")}
          activeThreadId={ThreadId.make("thread")}
          activeThreadTitle={longTitle}
          isServerThread
          activeProject={{ title: "atlas-api", isScratch: false } as never}
          parentThreadLink={null}
          onOpenThread={() => {}}
        />
        <div data-testid="toolbar" className="ms-auto flex shrink-0 gap-1">
          <button type="button" className="size-7">
            A
          </button>
          <button type="button" className="size-7">
            B
          </button>
        </div>
      </div>,
    );

    const text = screen
      .getByRole("heading", { level: 2 })
      .element()
      .querySelector<HTMLElement>("[data-slot=workspace-breadcrumb-text]")!;
    const toolbar = screen.getByTestId("toolbar").element();
    expect(text.scrollWidth, "the title overflows its box, so it is cut").toBeGreaterThan(
      text.clientWidth,
    );
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    // A wide header keeps a readable measure instead of running to the toolbar.
    const gap = toolbar.getBoundingClientRect().left - text.getBoundingClientRect().right;
    expect(gap).toBeGreaterThanOrEqual(headerWidth > 900 ? 48 : 0);
  },
);

it("shows the full thread title in a tooltip when the title is cut", async () => {
  const longTitle =
    "Investigate intermittent ECONNRESET errors on the /v1/webhooks/ingest endpoint when payloads exceed 1 MB behind the load balancer";
  await using screen = await render(
    <TooltipProvider delay={0}>
      <div style={{ width: 640 }} className="flex items-center gap-2 px-3">
        <ChatHeader
          activeThreadEnvironmentId={EnvironmentId.make("environment")}
          activeThreadId={ThreadId.make("thread")}
          activeThreadTitle={longTitle}
          isServerThread
          activeProject={{ title: "atlas-api", isScratch: false } as never}
          parentThreadLink={null}
          onOpenThread={() => {}}
        />
      </div>
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: `Thread actions for ${longTitle}` });
  await userEvent.hover(trigger);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(longTitle),
  );
});
