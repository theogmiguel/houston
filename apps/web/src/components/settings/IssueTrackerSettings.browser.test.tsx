import type { IssueTrackerConnectionList } from "@houston-app/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly value: unknown }>,
  data: null as IssueTrackerConnectionList | null,
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { readonly __value?: unknown }) => atom.__value,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: fixture.data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => undefined,
  }),
}));

vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useProjects: () => [{ id: "p1", title: "Web", environmentId: "env" }],
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly __label?: string }) => async (value: unknown) => {
    fixture.calls.push({ command: command.__label ?? "unknown", value });
    return { _tag: "Success", value: undefined };
  },
}));

vi.mock("~/state/issueTrackers", () => {
  const permission = () => ({ __value: true });
  return {
    issueTrackerEnvironment: {
      connections: () => ({ __value: null }),
      connect: { permissionAtom: permission, __label: "connect" },
      bindProject: { permissionAtom: permission, __label: "bind" },
    },
  };
});

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
    </div>
  ),
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { IssueTrackerSettings } from "./IssueTrackerSettings";
import type { EnvironmentId } from "@houston-app/contracts";

const connected = (): IssueTrackerConnectionList => ({
  trackers: [
    {
      tracker: "linear" as never,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
      connected: true,
      account: "ada",
      detail: null,
      scopes: [{ key: "ENG", name: "Engineering" }],
    },
  ],
  bindings: {},
});

describe("IssueTrackerSettings", () => {
  it("shows a connected tracker, lists its project bindings and disconnects it", async () => {
    fixture.data = connected();
    fixture.calls = [];
    await using _screen = await render(
      <IssueTrackerSettings environmentId={"env" as EnvironmentId} />,
    );

    await expect.element(page.getByText("Linear")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Connected as ada · no projects linked yet. Pick a team for a project to list its issues.",
        ),
      )
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Toggle Linear details" }));
    await expect.element(page.getByRole("combobox", { name: "Linear team for Web" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Disconnect Linear" }));
    expect(fixture.calls).toEqual([
      {
        command: "connect",
        value: { environmentId: "env", input: { tracker: "linear", token: null } },
      },
    ]);
  });

  it("renders nothing until the server reports a standalone tracker", async () => {
    fixture.data = { trackers: [], bindings: {} };
    await using screen = await render(
      <IssueTrackerSettings environmentId={"env" as EnvironmentId} />,
    );
    expect(screen.container.textContent).toBe("");
  });
});
