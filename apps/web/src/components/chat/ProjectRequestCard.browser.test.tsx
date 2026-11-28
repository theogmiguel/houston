import type { EnvironmentId } from "@houston-app/contracts";
import type { ProjectRequestItem } from "@houston-app/client-runtime/project-request";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ProjectRequestCard } from "./ProjectRequestCard";

let results: Array<unknown> = [];
const answers: Array<unknown> = [];

vi.mock("../../state/server", () => ({
  serverEnvironment: { answerProjectRequest: { label: "answer add-project request" } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    answers.push(input);
    return results.shift() ?? { _tag: "Success", value: undefined };
  },
}));

const item = (overrides: Partial<ProjectRequestItem> = {}): ProjectRequestItem =>
  ({
    type: "project_request",
    id: "turn-item:project-request:test",
    threadId: "thread:test",
    title: "NPS research",
    reason: "The repository holds the code the user asked about.",
    workspaceRoot: "/home/user/code/nps-research",
    createsFolder: false,
    createsRepository: false,
    projectRequestStatus: "pending",
    ...overrides,
  }) as unknown as ProjectRequestItem;

const failure = (message: string) => ({
  _tag: "Failure",
  cause: Cause.fail({ _tag: "HoustonProjectRequestError", message }),
});

const card = (overrides: Partial<ProjectRequestItem> = {}) => (
  <ProjectRequestCard
    environmentId={"local" as EnvironmentId}
    item={item(overrides)}
    visibility="local"
  />
);

describe("ProjectRequestCard", () => {
  it("lets a transient answer failure be retried", async () => {
    results = [failure("Could not load the add-project request.")];
    answers.length = 0;
    await using screen = await render(card());

    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add project" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(answers).toHaveLength(2);
  });

  it("keeps Add disabled only for the path that cannot register", async () => {
    results = [
      failure(
        "/home/user/code/nps-reserch is not a folder on this computer. Expected an existing folder.",
      ),
    ];
    answers.length = 0;
    await using screen = await render(card());

    await userEvent.click(screen.getByRole("button", { name: "Add project" }).element());
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add project" })).toBeDisabled();
  });
});
