import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ preview: vi.fn(), openLink: vi.fn() }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.preview }));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  readProjects: () => [project],
  useProjects: () => [project],
  readProject: () => project,
  readThreadShell: () => ({ projectId: "project", worktreePath: null }),
  useServerConfigs: () => new Map([["local", {}]]),
}));
vi.mock("../../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("../../state/server")>()),
    environmentServerConfigsAtom: Atom.make(new Map([["local", {}]])),
  };
});

import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { useRightPanelStore, selectActiveRightPanelSurface } from "../../rightPanelStore";
import type { RowPullRequest } from "../../grid/sidebar";
import { ThreadRowPullRequestBadge } from "./ThreadRowPullRequestBadge";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const project = {
  id: "project",
  environmentId,
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/acme/app",
    displayName: "acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/app.git",
    },
  },
};

function pullRequest(overrides: Partial<RowPullRequest> = {}): RowPullRequest {
  return {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    title: "Add the badge",
    checksState: null,
    ...overrides,
  };
}

function Harness({
  value,
  count = 1,
  onRowClick = () => {},
  onOpenThread = () => {},
}: {
  value: RowPullRequest;
  count?: number;
  onRowClick?: () => void;
  onOpenThread?: () => void;
}) {
  return (
    <AppAtomRegistryProvider>
      <ToastProvider>
        <TooltipProvider delay={0}>
          <div data-testid="row" onClick={onRowClick}>
            <ThreadRowPullRequestBadge
              threadRef={threadRef}
              pullRequest={value}
              pullRequestCount={count}
              onOpenThread={onOpenThread}
            />
          </div>
        </TooltipProvider>
      </ToastProvider>
    </AppAtomRegistryProvider>
  );
}

function setup() {
  state.preview.mockReset().mockResolvedValue(AsyncResult.success({ sources: [] }));
  state.openLink.mockReset().mockResolvedValue(undefined);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    pullRequestLinksOpenInApp: true,
    browserLinkTarget: "system",
  });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

function badge(container: HTMLElement): HTMLButtonElement {
  const element = container.querySelector("[data-thread-pull-request]");
  if (!(element instanceof HTMLButtonElement))
    throw new Error("The pull request badge is missing.");
  return element;
}

describe("pull request badge presentation", () => {
  it.each([
    ["open", "text-success-foreground"],
    ["draft", "text-muted-foreground"],
    ["merged", "text-merged-foreground"],
    ["closed", "text-error-foreground"],
  ] as const)("colours a %s pull request with %s", async (prState, tone) => {
    setup();
    await using screen = await render(<Harness value={pullRequest({ state: prState })} />);
    const element = badge(screen.container);
    expect(element.classList.contains(tone)).toBe(true);
    expect(element.querySelector("svg")).not.toBeNull();
    expect(element.textContent).toBe("#42");
  });

  it("shows no checks glyph when checks passed or are running", async () => {
    setup();
    for (const checksState of ["passing", "pending"] as const) {
      await using screen = await render(<Harness value={pullRequest({ checksState })} />);
      expect(badge(screen.container).querySelectorAll("svg")).toHaveLength(1);
    }
  });

  it("shows a red X when checks failed on an open pull request", async () => {
    setup();
    await using screen = await render(<Harness value={pullRequest({ checksState: "failing" })} />);
    const svgs = badge(screen.container).querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    expect(svgs[1]?.getAttribute("class")).toContain("text-error-foreground");
  });

  it("omits the checks glyph on merged and closed pull requests", async () => {
    setup();
    for (const prState of ["merged", "closed"] as const) {
      await using screen = await render(
        <Harness value={pullRequest({ state: prState, checksState: "failing" })} />,
      );
      expect(badge(screen.container).querySelectorAll("svg")).toHaveLength(1);
    }
  });

  it("names the pull request, its state, title and checks for assistive technology", async () => {
    setup();
    await using screen = await render(<Harness value={pullRequest({ checksState: "pending" })} />);
    expect(badge(screen.container).getAttribute("aria-label")).toBe(
      "PR #42 · Open: Add the badge. Checks running",
    );
  });

  it("explains the pull request in a tooltip", async () => {
    setup();
    await using screen = await render(<Harness value={pullRequest({ checksState: "failing" })} />);
    await userEvent.hover(badge(screen.container));
    await expect.element(page.getByText("PR #42 · Open: Add the badge")).toBeVisible();
    await expect.element(page.getByText("Checks failed")).toBeVisible();
  });
});

describe("pull request badge clicks", () => {
  it("opens the pull request in the right panel without reaching the row", async () => {
    setup();
    const onRowClick = vi.fn();
    const onOpenThread = vi.fn();
    await using screen = await render(
      <Harness value={pullRequest()} onRowClick={onRowClick} onOpenThread={onOpenThread} />,
    );
    await act(() => badge(screen.container).click());
    const surface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    expect(surface).toMatchObject({ kind: "pull-request", number: 42 });
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(state.openLink).not.toHaveBeenCalled();
  });

  it.each([
    ["ctrl", { ctrlKey: true, button: 0 }, "click"],
    ["meta", { metaKey: true, button: 0 }, "click"],
    ["middle", { button: 1 }, "auxclick"],
  ] as const)("opens the URL externally on %s+click", async (_name, init, type) => {
    setup();
    const onRowClick = vi.fn();
    await using screen = await render(<Harness value={pullRequest()} onRowClick={onRowClick} />);
    await act(() =>
      badge(screen.container).dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
      ),
    );
    expect(state.openLink).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/42",
      expect.objectContaining({ threadRef }),
    );
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens the pull request list when the thread has several", async () => {
    setup();
    await using screen = await render(<Harness value={pullRequest()} count={3} />);
    await act(() => badge(screen.container).click());
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "pull-requests" });
  });
});
