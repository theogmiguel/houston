import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type HoustonProjectRepositoriesResult,
  type HoustonProjectRepository,
} from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render, type Screen } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { ProjectRepositoriesSettings } from "./ProjectRepositoriesSettings";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");

type Result = HoustonProjectRepositoriesResult;

const state = vi.hoisted(() => ({
  canOperate: true,
  view: null as unknown,
  refresh: vi.fn(),
  track: vi.fn(),
  untrack: vi.fn(),
  setIgnore: vi.fn(),
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.canOperate) as never,
}));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => state.view) as never,
}));

vi.mock(import("~/state/projectRepositories"), () => {
  const command = (label: string, run: (input: unknown) => Promise<unknown>) => ({
    label,
    run: (_registry: unknown, input: unknown) => run(input),
  });
  return {
    projectRepositories: {
      list: (() => null) as never,
      track: command("track", state.track) as never,
      untrack: command("untrack", state.untrack) as never,
      setIgnorePatterns: command("ignore", state.setIgnore) as never,
    },
  };
});

const repository = (
  overrides: Partial<HoustonProjectRepository> = {},
): HoustonProjectRepository => ({
  key: ".",
  root: "/work/repo",
  branch: "main",
  detached: false,
  kind: "discovered",
  ...overrides,
});

const result = (overrides: Partial<Result> = {}): Result => ({
  projectId,
  repositories: [repository()],
  ignored: [],
  notices: [],
  ...overrides,
});

const trackedFolder = (index: number): HoustonProjectRepository => ({
  key: `../folder-${index}`,
  root: `/work/folder-${index}`,
  branch: `release-${index}`,
  detached: false,
  kind: "tracked",
});

function setup(overrides: Partial<Result> = {}, options: { canOperate?: boolean } = {}) {
  vi.clearAllMocks();
  state.canOperate = options.canOperate ?? true;
  const data = result(overrides);
  state.view = {
    data,
    dataUpdatedAt: 1,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => state.refresh(),
  };
  state.track.mockResolvedValue(AsyncResult.success(data));
  state.untrack.mockResolvedValue(AsyncResult.success(data));
  state.setIgnore.mockResolvedValue(AsyncResult.success(data));
  return data;
}

function mount() {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ProjectRepositoriesSettings environmentId={environmentId} projectId={projectId} />
    </RegistryContext.Provider>,
  );
}

const addFolderButton = (screen: Screen) => screen.getByRole("button", { name: "Add folder…" });

describe("project repositories", () => {
  it("lists discovered and submodule repositories with their branch", async () => {
    setup({
      repositories: [
        repository(),
        repository({ key: "vendor/lib", kind: "submodule", branch: "vendor/lib-branch" }),
        repository({ key: "apps/web", branch: null, detached: true }),
      ],
    });
    await using screen = await mount();

    expect(screen.container.textContent).toContain("Found in the project folder");
    expect(screen.container.textContent).toContain("vendor/lib");
    expect(screen.container.textContent).toContain("Submodule");
    expect(screen.container.textContent).toContain("vendor/lib-branch");
    expect(screen.container.textContent).toContain("detached");
    expect(screen.container.textContent).not.toContain("No repositories found");
  });

  it("middle-truncates a long path while keeping its ends readable", async () => {
    const key = "packages/a-really-long-repository-name-with-a-deep/nested/folder/tail";
    setup({ repositories: [repository(), repository({ key })] });
    await using screen = await mount();

    const shown = screen.container.querySelector<HTMLElement>(`[title="${key}"]`)!;
    expect(shown.textContent).toBe(key);
    expect(shown.className).toContain("overflow-hidden");
    expect(shown.getBoundingClientRect().width).toBeLessThanOrEqual(
      shown.parentElement!.getBoundingClientRect().width,
    );
  });

  it("keeps a one-repository project to its add folder row", async () => {
    setup();
    await using screen = await mount();

    expect(screen.container.textContent).not.toContain("Found in the project folder");
    expect(screen.container.textContent).not.toContain("Added folders");
    expect(screen.container.textContent).not.toContain("Ignored");
    expect(addFolderButton(screen)).toBeDefined();
  });

  it("shows empty states for the found and added lists", async () => {
    setup({ repositories: [] });
    await using screen = await mount();

    expect(screen.container.textContent).toContain("No repositories found");
    expect(screen.container.textContent).toContain("No added folders");
  });

  it("shows an unreadable repository and refetches from its retry control", async () => {
    setup({
      repositories: [
        repository({
          key: "vendor/lib",
          root: "/work/repo/vendor/lib",
          branch: null,
          error: "not a readable git repository",
        }),
      ],
    });
    await using screen = await mount();

    expect(screen.container.textContent).toContain(
      "Could not read vendor/lib: /work/repo/vendor/lib (not a readable git repository)",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it.each([112, 120, 128])("counts %i added folders and warns", async (count) => {
    setup({
      repositories: [
        repository(),
        ...Array.from({ length: count }, (_, index) => trackedFolder(index)),
      ],
    });
    await using screen = await mount();

    expect(screen.container.textContent).toContain(`${count} of 128 added folders`);

    if (count === 128) {
      expect(screen.container.textContent).toContain(
        "Cannot add a folder: 128 of 128 added folders",
      );
      await expect.element(addFolderButton(screen)).toBeDisabled();
      return;
    }
    const input = screen.getByRole("textbox", { name: "Folder path to add" });
    await userEvent.fill(input, "/work/another");
    await expect.element(addFolderButton(screen)).not.toBeDisabled();
  });

  it("keeps a track failure's server message in an alert", async () => {
    setup({ repositories: [repository(), repository({ key: "apps/web" })] });
    state.track.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new Error(
            "Project project already tracks 128 folders and the limit is 128; /work/extra was not added.",
          ),
        ),
      ),
    );
    await using screen = await mount();

    await userEvent.fill(
      screen.getByRole("textbox", { name: "Folder path to add" }),
      "/work/extra",
    );
    await userEvent.click(addFolderButton(screen));

    expect(state.track).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, path: "/work/extra" },
    });
    expect(screen.container.textContent).toContain(
      "Project project already tracks 128 folders and the limit is 128; /work/extra was not added.",
    );
  });

  it("adds and removes tracked folders by their absolute path", async () => {
    setup({
      repositories: [repository(), trackedFolder(1)],
    });
    await using screen = await mount();

    await userEvent.fill(
      screen.getByRole("textbox", { name: "Folder path to add" }),
      "/work/extra",
    );
    await userEvent.click(addFolderButton(screen));
    expect(state.track).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, path: "/work/extra" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Stop covering /work/folder-1" }));
    expect(state.untrack).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, path: "/work/folder-1" },
    });
  });

  it("saves trimmed, deduplicated ignore patterns only when they changed", async () => {
    setup({
      repositories: [repository(), repository({ key: "legacy" })],
      ignored: ["legacy", "vendor/**"],
    });
    await using screen = await mount();

    const patterns = screen.getByRole("textbox", { name: "Ignored repository patterns" });
    const save = screen.getByRole("button", { name: "Save" });
    await expect.element(patterns).toHaveValue("legacy\nvendor/**");
    await expect.element(save).toBeDisabled();
    expect(screen.container.textContent).toContain("No changes to save.");

    await userEvent.fill(patterns, " legacy \nvendor/**\nnew/** \nnew/** ");
    await expect.element(save).not.toBeDisabled();
    await userEvent.click(save);

    expect(state.setIgnore).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, patterns: ["legacy", "vendor/**", "new/**"] },
    });
  });

  it("names the discovery bound that tripped", async () => {
    setup({
      repositories: [repository(), repository({ key: "apps" })],
      notices: [{ limit: "repositories", limitValue: 64, actual: 64, requested: "vendor/next" }],
    });
    await using screen = await mount();

    expect(screen.container.textContent).toContain(
      "Repository discovery hit the repository limit of 64 with 64 found; vendor/next was not returned.",
    );
  });

  it("disables every change with a reason when the connection may not operate", async () => {
    setup(
      {
        repositories: [repository(), trackedFolder(1)],
        ignored: ["legacy"],
      },
      { canOperate: false },
    );
    await using screen = await mount();

    expect(screen.container.textContent).toContain(
      "This connection cannot change this project's repositories.",
    );
    await expect.element(addFolderButton(screen)).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Stop covering /work/folder-1" }))
      .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows a failed list with retry", async () => {
    vi.clearAllMocks();
    state.view = {
      data: null,
      dataUpdatedAt: 0,
      error: "The project could not be read.",
      failure: null,
      isPending: false,
      isSuccess: false,
      refresh: () => state.refresh(),
    };
    await using screen = await mount();

    expect(screen.container.textContent).toContain("The project could not be read.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refresh).toHaveBeenCalledOnce();
  });
});

const captureDir = import.meta.env.VITE_HOUSTON_CAPTURE_DIR as string | undefined;
const capturesEnabled = Boolean(captureDir?.trim());

describe.skipIf(!capturesEnabled)("project repositories captures", () => {
  const states: ReadonlyArray<{
    readonly name: string;
    readonly data: () => Partial<Result>;
    readonly beforeCapture?: (screen: Screen) => Promise<void>;
  }> = [
    {
      name: "several",
      data: () => ({
        repositories: [
          repository(),
          repository({ key: "vendor/lib", kind: "submodule", branch: "release/vendor-library" }),
          repository({ key: "apps/web", branch: "houston/web-refactor" }),
          trackedFolder(1),
        ],
        ignored: ["legacy", "vendor/**"],
      }),
    },
    {
      name: "long-paths",
      data: () => ({
        repositories: [
          repository({ key: "." }),
          repository({
            key: "packages/a-really-long-repository-name-with-a-deep/nested/folder/tail",
            branch: "houston/a-very-long-branch-name-that-keeps-going",
          }),
        ],
        ignored: [],
      }),
    },
    { name: "single", data: () => ({}) },
    { name: "empty", data: () => ({ repositories: [] }) },
    {
      name: "unreadable",
      data: () => ({
        repositories: [
          repository(),
          repository({
            key: "vendor/lib",
            root: "/work/repo/vendor/lib",
            branch: null,
            error: "not a readable git repository",
          }),
        ],
      }),
    },
    {
      name: "near-limit-112",
      data: () => ({
        repositories: [
          repository(),
          ...Array.from({ length: 112 }, (_, index) => trackedFolder(index)),
        ],
      }),
    },
    {
      name: "at-limit-128",
      data: () => ({
        repositories: [
          repository(),
          ...Array.from({ length: 128 }, (_, index) => trackedFolder(index)),
        ],
      }),
    },
    {
      name: "track-error",
      data: () => ({ repositories: [repository(), repository({ key: "apps/web" })] }),
      beforeCapture: async (screen) => {
        state.track.mockResolvedValueOnce(
          AsyncResult.failure(
            Cause.fail(
              new Error(
                "Project project already tracks 128 folders and the limit is 128; /work/extra was not added.",
              ),
            ),
          ),
        );
        await userEvent.fill(
          screen.getByRole("textbox", { name: "Folder path to add" }),
          "/work/extra",
        );
        await userEvent.click(addFolderButton(screen));
      },
    },
  ];

  it.each([
    [900, "light"],
    [900, "dark"],
    [390, "light"],
    [390, "dark"],
  ] as const)("captures every state at %ipx in %s", async (width, theme) => {
    const directory = captureDir!.trim().replace(/\/+$/u, "");
    for (const entry of states) {
      setup(entry.data());
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.viewport(width, 900);
      await using screen = await mount();
      if (entry.beforeCapture) await entry.beforeCapture(screen);
      await page.screenshot({
        element: screen.container,
        path: `${directory}/settings/${entry.name}-${theme}-${width}.png`,
      });
    }
    document.documentElement.classList.remove("dark");
  });
});
