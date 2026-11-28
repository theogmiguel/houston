import { describe, expect, it } from "vite-plus/test";

import {
  projectRequestAnswerInput,
  projectRequestDisplay,
  projectRequestFailureMessage,
  type ProjectRequestItem,
} from "./projectRequest.ts";

const item = {
  id: "turn-item:project-request:test",
  threadId: "thread:test",
  type: "project_request",
  title: "Research",
  reason: "The repository holds the code.",
  workspaceRoot: "/home/user/code/nps-research",
  createsFolder: false,
  createsRepository: false,
  projectRequestStatus: "pending",
} as unknown as ProjectRequestItem;

describe("projectRequestDisplay", () => {
  it("offers the form in the thread where the card was asked", () => {
    expect(projectRequestDisplay(item, "local")).toEqual({ kind: "pending", adding: false });
  });

  it("does not offer the form on an inherited copy", () => {
    expect(projectRequestDisplay(item, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
  });

  it("shows the one approved call running", () => {
    expect(projectRequestDisplay({ projectRequestStatus: "adding" }, "local")).toEqual({
      kind: "pending",
      adding: true,
    });
  });

  it("names each closed outcome", () => {
    expect(projectRequestDisplay({ projectRequestStatus: "added" }, "local")).toMatchObject({
      kind: "answered",
      outcome: "added",
      label: "Added",
    });
    expect(projectRequestDisplay({ projectRequestStatus: "declined" }, "local")).toMatchObject({
      outcome: "declined",
      label: "Declined",
    });
    expect(projectRequestDisplay({ projectRequestStatus: "cancelled" }, "local")).toMatchObject({
      outcome: "cancelled",
      label: "Cancelled",
    });
    expect(projectRequestDisplay({ projectRequestStatus: "failed" }, "local")).toMatchObject({
      outcome: "failed",
      label: "Could not add",
    });
  });
});

describe("projectRequestAnswerInput", () => {
  it("answers the exact card", () => {
    expect(projectRequestAnswerInput(item, "approve")).toEqual({
      threadId: "thread:test",
      turnItemId: "turn-item:project-request:test",
      answer: { type: "approve" },
    });
    expect(projectRequestAnswerInput(item, "decline")).toMatchObject({
      answer: { type: "decline" },
    });
  });
});

describe("projectRequestFailureMessage", () => {
  it("passes a known server message through and hides anything else", () => {
    expect(
      projectRequestFailureMessage({
        _tag: "HoustonProjectRequestError",
        message: "This add-project request was already answered.",
      }),
    ).toBe("This add-project request was already answered.");
    expect(projectRequestFailureMessage({ _tag: "OtherError", message: "/secret/path" })).toBe(
      "Could not answer the request. Try again.",
    );
  });
});
