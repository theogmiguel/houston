import type {
  EnvironmentId,
  IssueListEntry,
  IssueListResult,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
} from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupIssues, holdIssuePages } from "./issueList";

const environmentId = "env-1" as EnvironmentId;
const api = "api" as ProjectId;

function entry(overrides: Partial<IssueListEntry> & { key: string; url: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/api",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    projectId: api,
    projectTitle: "api",
    ...overrides,
  };
}

function answer(overrides: Partial<IssueListResult>): IssueListResult {
  return { viewers: {}, trackers: [], entries: [], errors: [], nextCursors: {}, ...overrides };
}

const capabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
};

describe("groupIssues", () => {
  it("lists an issue once when two environments hold the same repository", () => {
    const github = {
      tracker: "github",
      host: "github.com",
      projectCount: 1,
      capabilities,
      configured: true,
      detail: null,
    } as IssueTrackerSummary;
    const page = answer({
      trackers: [github],
      entries: [
        entry({ key: "1", url: "https://github.com/acme/api/issues/1" }),
        entry({ key: "2", url: "https://github.com/acme/api/issues/2" }),
      ],
    });
    const held = holdIssuePages(
      [
        [environmentId, page],
        [
          "env-2" as EnvironmentId,
          answer({
            ...page,
            entries: page.entries.map((row) => ({ ...row, projectId: "other" as ProjectId })),
          }),
        ],
      ],
      new Map(),
    );
    const [group] = groupIssues(held, "", []);
    expect(group!.rows.map((row) => row.displayKey)).toEqual(["#1", "#2"]);
  });

  it("keeps same-keyed issues from two Linear workspaces apart", () => {
    const linear = {
      tracker: "linear",
      host: "linear.app",
      projectCount: 1,
      capabilities,
      configured: true,
      detail: null,
    } as IssueTrackerSummary;
    const inWorkspace = (workspace: string) =>
      answer({
        trackers: [linear],
        entries: [
          entry({
            tracker: "linear" as IssueTrackerKind,
            host: "linear.app",
            scope: "ENG",
            key: "ENG-1",
            displayKey: "ENG-1",
            url: `https://linear.app/${workspace}/issue/ENG-1`,
          }),
        ],
      });
    const held = holdIssuePages(
      [
        [environmentId, inWorkspace("acme")],
        ["env-2" as EnvironmentId, inWorkspace("globex")],
      ],
      new Map(),
    );
    const [group] = groupIssues(held, "", []);
    expect(group!.rows.map((row) => row.url)).toEqual([
      "https://linear.app/acme/issue/ENG-1",
      "https://linear.app/globex/issue/ENG-1",
    ]);
  });
});
