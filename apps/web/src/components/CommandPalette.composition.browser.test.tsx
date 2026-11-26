import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@houston-app/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPaletteShell";
// The shell loads its body on demand; loading it here keeps a cold transform out of the polls.
import "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const state = vi.hoisted(() => ({
  browseData: undefined as unknown,
  linkedSearch: {
    enabled: false,
    machines: [],
    isSearching: false,
    failed: [],
    retry: () => undefined,
  } as unknown,
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
          newProjectsRoot: "/workspace/projects/",
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
  useLinkedThreadSearch: () => state.linkedSearch,
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/tasks", async (original) => {
  const [actual, { EMPTY_TASKS_SNAPSHOT }] = await Promise.all([
    original<typeof import("../state/tasks")>(),
    import("@houston-app/client-runtime/state/tasks"),
  ]);
  return { ...actual, useAllTasksSnapshot: () => EMPTY_TASKS_SNAPSHOT };
});
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: state.browseData, isLoading: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() =>
      openCommandPalette({
        open: "add-project",
        addProject: { action: step === "folder" ? "open-folder" : "clone" },
      }),
    );
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else if (step === "folder") {
      // A path that does not exist is never created from Enter alone.
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue(value);
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

it("keeps the caret in place when an edit briefly makes the folder path not a path", async () => {
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() =>
    openCommandPalette({ open: "add-project", addProject: { action: "open-folder" } }),
  );
  const input = () => page.getByRole("combobox");
  await input().fill("/workspace/project");
  await userEvent.keyboard("{Home}{ArrowRight}{Backspace}");
  await expect.element(input()).toHaveValue("workspace/project");
  await userEvent.keyboard("/");
  await expect.element(input()).toHaveValue("/workspace/project");
  await userEvent.keyboard("w");
  await expect.element(input()).toHaveValue("/wworkspace/project");
});

describe("add folder path mode", () => {
  it("starts browsing from the add-project base folder under StrictMode", async () => {
    state.browseData = undefined;
    await using _screen = await render(
      <StrictMode>
        <CommandPalette>{null}</CommandPalette>
      </StrictMode>,
    );
    await act(() =>
      openCommandPalette({ open: "add-project", addProject: { action: "open-folder" } }),
    );

    await expect.element(page.getByRole("combobox")).toHaveValue("/workspace/");
  });

  it("does not create a folder when Enter confirms a path that does not exist", async () => {
    state.browseData = undefined;
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() =>
      openCommandPalette({ open: "add-project", addProject: { action: "open-folder" } }),
    );

    const input = () => page.getByRole("combobox");
    await input().fill("/workspace/missing");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByText("Create folder /workspace/missing and add it", { exact: true }))
      .toBeInTheDocument();
    await expect.element(input()).toHaveValue("/workspace/missing");
  });

  it("creates a folder only from its explicit row", async () => {
    state.browseData = undefined;
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() =>
      openCommandPalette({ open: "add-project", addProject: { action: "open-folder" } }),
    );

    await page.getByRole("combobox").fill("/workspace/missing");
    await page.getByText("Create folder /workspace/missing and add it", { exact: true }).click();

    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  });

  it("adds an existing folder typed with a trailing separator on Enter", async () => {
    state.browseData = { parentPath: "/workspace/notes-app", entries: [] };
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() =>
      openCommandPalette({ open: "add-project", addProject: { action: "open-folder" } }),
    );

    await page.getByRole("combobox").fill("/workspace/notes-app/");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  });

  it("adds the existing folder a typed path names on Enter", async () => {
    state.browseData = {
      parentPath: "/workspace",
      entries: [{ name: "missing", fullPath: "/workspace/missing" }],
    };
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() =>
      openCommandPalette({ open: "add-project", addProject: { action: "open-folder" } }),
    );

    await page.getByRole("combobox").fill("/workspace/missing");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("linked machine results", () => {
  const machine = (overrides: Record<string, unknown> = {}) => ({
    environmentId: "environment-box",
    label: "Homelab",
    status: "ok",
    matches: [],
    ...overrides,
  });

  it("names the machine on each linked row and renders its text, never a link", async () => {
    state.linkedSearch = {
      enabled: true,
      machines: [
        machine({
          matches: [
            {
              threadId: "thread:box-1",
              projectId: "project:box",
              title: "Rotate the Postgres backup credentials",
              source: "title",
            },
          ],
        }),
      ],
      isSearching: false,
      failed: [],
      retry: () => undefined,
    };
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "postgres" });

    await expect
      .element(page.getByText("Rotate the Postgres backup credentials"))
      .toBeInTheDocument();
    await expect.element(page.getByText("Homelab")).toBeInTheDocument();
    expect(page.getByRole("link").elements()).toHaveLength(0);
  });

  it("names a machine that did not answer, offers Retry and does not claim nothing matched", async () => {
    let retried = 0;
    state.linkedSearch = {
      enabled: true,
      machines: [machine({ status: "unreachable", matches: [] })],
      isSearching: false,
      failed: [machine({ status: "unreachable" })],
      retry: () => {
        retried += 1;
      },
    };
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "kubernetes" });

    await expect.element(page.getByText(/isn't answering/)).toBeInTheDocument();
    await expect.element(page.getByText("No matches on this machine.")).toBeInTheDocument();
    await act(() => {
      (page.getByText("Retry", { exact: true }).element() as HTMLElement).click();
    });
    expect(retried).toBe(1);
  });

  it("names the machines it is still searching", async () => {
    state.linkedSearch = {
      enabled: true,
      machines: [machine({ status: "searching" })],
      isSearching: true,
      failed: [],
      retry: () => undefined,
    };
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "reconnect" });

    await expect.element(page.getByText("Searching Homelab")).toBeInTheDocument();
  });
});
