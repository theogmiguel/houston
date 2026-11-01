import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { render } from "../../../test/render";
import { SettingsScopeSentence } from "./SettingsScopeSentence";
import type { SettingsScopeSearch } from "./settingsScope";

const laptopId = EnvironmentId.make("laptop");
const remoteId = EnvironmentId.make("remote");
const offlineId = EnvironmentId.make("offline");

const state = vi.hoisted(() => ({
  scope: null as unknown as {
    scope: { kind: "all" };
    search: SettingsScopeSearch;
    groups: SidebarProjectSnapshot[];
    singleEnvironment: boolean;
    selectScope: ReturnType<typeof vi.fn>;
  },
  environments: [] as unknown[],
  primaryId: null as EnvironmentId | null,
}));

vi.mock(import("./SettingsScopeContext"), () => ({
  useOptionalSettingsScope: (() => state.scope) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  usePrimaryEnvironmentId: () => state.primaryId,
}));

function member(
  id: string,
  environmentId: EnvironmentId,
  workspaceRoot = `/repos/${id}`,
): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot,
    physicalProjectKey: `${environmentId}:${workspaceRoot}`,
    environmentLabel: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
  displayName = projectKey,
) {
  return {
    ...members[0]!,
    projectKey,
    displayName,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
  } as SidebarProjectSnapshot;
}

function environment(
  environmentId: EnvironmentId,
  label: string,
  displayUrl: string | null,
  phase: "connected" | "disconnected",
) {
  return {
    environmentId,
    label,
    displayUrl,
    connection: { phase },
    serverConfig: null,
  };
}

const houston = group("Houston", [
  member("houston", laptopId),
  member("houston-remote", remoteId),
  member("houston-offline", offlineId),
]);

function setup({
  search = {},
  groups = [houston],
  singleEnvironment = false,
  environments = [
    environment(laptopId, "theo-Latitude-3550", "http://localhost:3773", "connected"),
  ],
}: {
  search?: SettingsScopeSearch;
  groups?: SidebarProjectSnapshot[];
  singleEnvironment?: boolean;
  environments?: unknown[];
} = {}) {
  state.environments = environments;
  state.primaryId = laptopId;
  state.scope = {
    scope: { kind: "all" },
    search,
    groups,
    singleEnvironment,
    selectScope: vi.fn(),
  };
  return state.scope;
}

const projectTrigger = () => page.getByRole("button", { name: /^Project scope:/ });
const environmentTrigger = () => page.getByRole("button", { name: /^Environment scope:/ });
const choice = (name: RegExp) => page.getByRole("menuitemradio", { name });

describe("settings scope sentence", () => {
  it("reads as a muted sentence with two plain triggers", async () => {
    setup();
    await using screen = await render(<SettingsScopeSentence />, { router: "/settings/providers" });

    expect(screen.getByText("Applying settings for")).not.toBeNull();
    await expect.element(projectTrigger()).toHaveTextContent("All projects");
    await expect.element(environmentTrigger()).toHaveTextContent("All environments");
    expect(projectTrigger().element().querySelector("svg")).not.toBeNull();
  });

  it("keeps the project selection and its menu primitive rows", async () => {
    const scope = setup();
    await using _screen = await render(<SettingsScopeSentence />, {
      router: "/settings/providers",
    });

    await userEvent.click(projectTrigger());
    await expect.element(choice(/^All projects/)).toBeVisible();
    await expect.element(choice(/^Houston/)).toBeVisible();
    expect(
      choice(/^Houston/)
        .element()
        .querySelector(".font-mono"),
    ).toBeNull();
    await userEvent.click(choice(/^Houston/));

    expect(scope.selectScope).toHaveBeenCalledWith({ project: "Houston" });
  });

  it("marks this machine, remote hosts and offline hosts in the environment menu", async () => {
    setup({
      search: { project: "Houston" },
      environments: [
        environment(laptopId, "theo-Latitude-3550", "http://localhost:3773", "connected"),
        environment(remoteId, "studio-ubuntu", "http://192.168.0.42:3773", "connected"),
        environment(
          offlineId,
          "build-server-rack-07",
          "http://build.internal:3773",
          "disconnected",
        ),
      ],
    });
    await using screen = await render(<SettingsScopeSentence />, { router: "/settings/providers" });

    expect(screen.getByText("on")).not.toBeNull();
    await userEvent.click(environmentTrigger());
    await expect.element(choice(/^All environments/)).toBeVisible();
    expect(choice(/^All environments/).element().textContent).toContain("Every connected machine");
    expect(choice(/^theo-Latitude-3550/).element().textContent).toContain("This machine");
    expect(choice(/^studio-ubuntu/).element().textContent).toContain("192.168.0.42:3773");
    expect(choice(/^build-server-rack-07/).element().textContent).toContain("Offline");
  });

  it("filters the project list once it passes eight rows", async () => {
    const groups = Array.from({ length: 10 }, (_, index) =>
      group(index === 0 ? "Houston" : `project-${index}`, [
        member(index === 0 ? "houston" : `project-${index}`, laptopId),
      ]),
    );
    setup({
      groups,
      environments: [
        environment(laptopId, "theo-Latitude-3550", "http://localhost:3773", "connected"),
      ],
    });
    await using _screen = await render(<SettingsScopeSentence />, {
      router: "/settings/providers",
    });

    await userEvent.click(projectTrigger());
    const filter = page.getByRole("textbox", { name: "Search projects" });
    await expect.element(filter).toBeVisible();
    await userEvent.fill(filter, "project-7");
    await expect.element(choice(/^project-7/)).toBeVisible();
    await expect.element(choice(/^Houston/)).not.toBeInTheDocument();
  });

  it("shows the path in mono only when two projects share a name", async () => {
    setup({
      groups: [
        group("houston-alpha", [member("houston-alpha", laptopId, "/repos/alpha")], "Houston"),
        group("houston-beta", [member("houston-beta", laptopId, "/repos/beta")], "Houston"),
      ],
      environments: [
        environment(laptopId, "theo-Latitude-3550", "http://localhost:3773", "connected"),
      ],
    });
    await using _screen = await render(<SettingsScopeSentence />, {
      router: "/settings/providers",
    });

    await userEvent.click(projectTrigger());
    const alphaRow = page.getByRole("menuitemradio", { name: /\/repos\/alpha/ });
    await expect.element(alphaRow).toBeVisible();
    const path = alphaRow.element().querySelector(".font-mono");
    expect(path?.textContent).toContain("/repos/alpha");
  });

  it("states that a device-only page ignores the project scope", async () => {
    setup();
    await using screen = await render(<SettingsScopeSentence />, {
      router: "/settings/appearance",
    });

    expect(screen.container.textContent).toContain("App-wide.");
    expect(screen.container.textContent).toContain(
      "These settings apply to the app on this machine, not to a project.",
    );
    expect(screen.getByRole("button", { name: /^Project scope:/ }).query()).toBeNull();
  });

  it("keeps an offline selected machine and marks it in the trigger", async () => {
    setup({
      search: { project: "Houston", machine: "offline" },
      environments: [
        environment(laptopId, "theo-Latitude-3550", "http://localhost:3773", "connected"),
        environment(
          offlineId,
          "build-server-rack-07",
          "http://build.internal:3773",
          "disconnected",
        ),
      ],
    });
    await using screen = await render(<SettingsScopeSentence />, { router: "/settings/providers" });

    await expect.element(environmentTrigger()).toBeVisible();
    expect(environmentTrigger().element().textContent).toContain("build-server-rack-07");
    expect(environmentTrigger().element().textContent).toContain("Offline");
    expect(screen.getByText("Offline")).not.toBeNull();
  });

  it("opens from the keyboard and moves between rows", async () => {
    setup();
    await using _screen = await render(<SettingsScopeSentence />, {
      router: "/settings/providers",
    });

    await userEvent.click(projectTrigger());
    await userEvent.keyboard("{Escape}");
    await expect.element(choice(/^Houston/)).not.toBeInTheDocument();
    projectTrigger().element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(choice(/^Houston/)).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(choice(/^Houston/)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.element(choice(/^All projects/)).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(choice(/^Houston/)).toHaveFocus();
  });
});
