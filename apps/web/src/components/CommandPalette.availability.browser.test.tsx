import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@houston-app/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@houston-app/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { createLayoutState } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { CommandPalette } from "./CommandPaletteShell";
// The shell loads its body on demand; loading it here keeps a cold transform out of the polls.
import "./CommandPalette";

const state = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<unknown>,
  discovery: null as unknown,
  providers: new Map() as ReadonlyMap<string, ReadonlyArray<unknown>>,
  activeDraftThread: null as unknown,
  queueSnapshot: null as unknown,
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
  useScratchProject: () => ({
    scratchEnvironmentId: () => "local",
    scratchWorkspaceRootFor: () => "/home/user/.houston/v2/scratch",
    startScratchThread: async () => undefined,
  }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: state.activeDraftThread,
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
          environment: {
            platform: { os: "linux" },
            capabilities: { projectCloneTracking: true, triage: true, mcpApprovalCodes: true },
          },
          settings: {
            addProjectBaseDirectory: "/workspace/",
            providerInstances: {},
            projectSettingsOverrides: {},
          },
          newProjectsRoot: "/workspace/projects/",
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => state.providers,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => state.projects,
  useThreadShells: () => [],
  useVisibleThreadShells: () => [],
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
  useEnvironmentQuery: () => ({ data: state.discovery, isLoading: false }),
}));
vi.mock("../state/mergeQueue", () => ({
  mergeQueueEnvironment: {},
  useMergeQueueEntry: () => ({ entry: null, snapshot: null, error: null, isPending: false }),
  useMergeQueueSnapshot: () => ({
    snapshot: state.queueSnapshot,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

const environmentId = EnvironmentId.make("local");

const scratchProject = {
  id: ProjectId.make("scratch"),
  environmentId,
  title: "No project",
  workspaceRoot: "/home/user/.houston/v2/scratch",
  isScratch: true,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const repositoryIdentity = {
  canonicalKey: "github.com/acme/atlas-api",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/atlas-api.git",
  },
};

const realProject = {
  id: ProjectId.make("atlas-api"),
  environmentId,
  title: "atlas-api",
  workspaceRoot: "/workspace/atlas-api",
  repositoryIdentity,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const connectedDiscovery = {
  versionControlSystems: [],
  sourceControlProviders: [
    {
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
      label: "GitHub",
      status: "available",
      installHint: "",
      version: { _tag: "None" },
      detail: { _tag: "None" },
      auth: {
        status: "authenticated",
        account: { _tag: "None" },
        host: { _tag: "None" },
        detail: { _tag: "None" },
      },
    },
  ],
};

const readyProvider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

const mergeQueueSnapshot = {
  projectId: realProject.id,
  entries: [],
  log: [],
  settings: {
    projectId: realProject.id,
    mergeWhenVerified: true,
    verificationCommand: "",
    timeLimitMinutes: 30,
    paused: false,
    revision: 1,
  },
  globalPaused: false,
  away: { merged: 0, parked: 0 },
  handOff: null,
  message: null,
};

function newUser(): void {
  state.projects = [scratchProject];
  state.discovery = null;
  state.providers = new Map();
  state.activeDraftThread = null;
  state.queueSnapshot = null;
}

function activeUser(): void {
  state.projects = [realProject];
  state.discovery = connectedDiscovery;
  state.providers = new Map([["local", [readyProvider]]]);
  state.activeDraftThread = {
    threadId: ThreadId.make("draft-thread-1"),
    environmentId,
    projectId: realProject.id,
    logicalProjectKey: `local:${realProject.id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
    promotedTo: null,
  };
  state.queueSnapshot = mergeQueueSnapshot;
  const layout = createLayoutState();
  const workspace = layout.workspaces[0]!;
  useLayoutStore.setState({
    layout: {
      ...layout,
      workspaces: [workspace, { ...workspace, id: "workspace-2", name: "Second" }],
    },
  });
}

async function search(query: string): Promise<void> {
  await act(() => openCommandPalette({ query }));
  await expect
    .element(page.getByPlaceholder("Search commands, projects, and threads..."))
    .toHaveValue(query);
}

async function expectNoMatch(text: string, query: string): Promise<void> {
  await search(query);
  expect(page.getByText(text, { exact: true }).elements()).toHaveLength(0);
}

function resetPalette(): void {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  useLayoutStore.setState({ layout: createLayoutState() });
  newUser();
}

describe("command palette availability", () => {
  it("lists only commands a new user can act on", async () => {
    resetPalette();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    await expectNoMatch("Open merge queue", "merge queue");
    await expectNoMatch("Pause merge queue", "pause merge queue");
    await expectNoMatch("Triage an issue", "triage");
    await expectNoMatch("Use Houston in another app (MCP)", "mcp");
    await expectNoMatch("Hide workspace from the sidebar", "hide workspace");
    await expectNoMatch("Go to file", "file picker");
    await expectNoMatch("Search project contents", "content search");

    await search("new project");
    await expect.element(page.getByText("New thread in...", { exact: true })).toBeInTheDocument();
    expect(page.getByText("New project", { exact: true }).elements()).toHaveLength(0);

    await search("add project");
    await expect.element(page.getByText("Add project", { exact: true })).toBeInTheDocument();
  });

  it("lists each command once its own state can act", async () => {
    resetPalette();
    activeUser();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    await search("merge queue");
    await expect.element(page.getByText("Open merge queue", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Pause merge queue", { exact: true })).toBeInTheDocument();

    await search("pull requests");
    await expect.element(page.getByText("Open pull requests", { exact: true })).toBeInTheDocument();

    await search("triage");
    await expect.element(page.getByText("Triage an issue", { exact: true })).toBeInTheDocument();

    await search("mcp");
    await expect
      .element(page.getByText("Use Houston in another app (MCP)", { exact: true }))
      .toBeInTheDocument();

    await search("hide workspace");
    await expect
      .element(page.getByText("Hide workspace from the sidebar", { exact: true }))
      .toBeInTheDocument();

    await search("file picker");
    await expect.element(page.getByText("Go to file", { exact: true })).toBeInTheDocument();

    await search("content search");
    await expect
      .element(page.getByText("Search project contents", { exact: true }))
      .toBeInTheDocument();
  });
});
