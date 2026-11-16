import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { TooltipProvider } from "../ui/tooltip";
import { ProjectFilterPicker } from "./ProjectFilterPicker";

function group(key: string, name: string, environmentId = "env-1"): SidebarProjectSnapshot {
  return {
    projectKey: key,
    displayName: name,
    memberProjects: [{ environmentId, id: key, environmentLabel: environmentId }],
  } as unknown as SidebarProjectSnapshot;
}

const groups = [group("a", "Alpha"), group("b", "Beta"), group("c", "Gamma")];

function picker(
  props: Partial<Parameters<typeof ProjectFilterPicker>[0]> & {
    onChange?: (keys: string[]) => void;
  } = {},
) {
  return (
    <TooltipProvider delay={0}>
      <ProjectFilterPicker
        groups={groups}
        activeKeys={[]}
        primaryEnvironmentId={"env-1" as never}
        machineByEnvironmentId={new Map()}
        onChange={() => {}}
        onOpenSettings={() => {}}
        {...props}
      />
    </TooltipProvider>
  );
}

async function openMenu(screen: Awaited<ReturnType<typeof render>>, name = "Filter by project") {
  await userEvent.click(screen.getByRole("button", { name }).element());
}

describe("ProjectFilterPicker", () => {
  it("chooses one project on a click and leaves the menu open for a Shift-click", async () => {
    const onChange = vi.fn();
    await using screen = await render(picker({ onChange }));
    await openMenu(screen);
    await userEvent.click(screen.getByRole("menuitem", { name: /Beta/ }).element());
    expect(onChange).toHaveBeenLastCalledWith(["b"]);
    expect(screen.getByRole("menuitem", { name: /Gamma/ }).element()).toBeVisible();
  });

  it("adds a project to the choice on Shift-click", async () => {
    const onChange = vi.fn();
    await using screen = await render(picker({ activeKeys: ["a"], onChange }));
    await openMenu(screen, "Filter by project: Alpha");
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(screen.getByRole("menuitem", { name: /Gamma/ }).element());
    await userEvent.keyboard("{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(["a", "c"]);
  });

  it("clears the filter from All projects", async () => {
    const onChange = vi.fn();
    await using screen = await render(picker({ activeKeys: ["a", "b"], onChange }));
    await openMenu(screen, "Filter by project: Alpha, Beta");
    await userEvent.click(screen.getByRole("menuitem", { name: /All projects/ }).element());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("names the chosen projects on the trigger and marks it active", async () => {
    await using screen = await render(picker({ activeKeys: ["b", "c"] }));
    const trigger = screen.getByRole("button", { name: "Filter by project: Beta, Gamma" });
    expect(trigger.element().getAttribute("data-project-filter")).toBe("active");
  });

  it("opens Project settings from the gear and from a right-click", async () => {
    const onOpenSettings = vi.fn();
    await using screen = await render(picker({ onOpenSettings }));
    await openMenu(screen);
    await userEvent.click(
      screen
        .getByRole("button", { name: "Project settings for Beta", includeHidden: true })
        .element(),
    );
    expect(onOpenSettings).toHaveBeenLastCalledWith(groups[1]);

    screen
      .getByRole("menuitem", { name: /Gamma/ })
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(onOpenSettings).toHaveBeenLastCalledWith(groups[2]);
  });

  it("shows where a project lives only when the projects span environments", async () => {
    await using single = await render(picker());
    await openMenu(single);
    expect(document.querySelector("[aria-label^='On ']")).toBeNull();
    await single[Symbol.asyncDispose]();

    const spanning = [group("a", "Alpha"), group("r", "Remote", "env-2")];
    await using screen = await render(
      picker({
        groups: spanning,
        machineByEnvironmentId: new Map(),
        primaryEnvironmentId: "env-1" as never,
      }),
    );
    await openMenu(screen);
    expect(document.querySelector("[aria-label='On env-2']")).not.toBeNull();
  });
});
