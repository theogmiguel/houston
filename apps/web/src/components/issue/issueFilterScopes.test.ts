import type {
  EnvironmentId,
  IssueListEntry,
  IssueListResult,
  IssueTrackerKind,
  IssueTrackerSummary,
  ProjectId,
} from "@houston-app/contracts";
import type { EnvironmentProject } from "@houston-app/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { issueFilterScopes } from "./issueFilterScopes";

const environmentId = "env-1" as EnvironmentId;
const api = "api" as ProjectId;

function entry(overrides: Partial<IssueListEntry> & { key: string }): IssueListEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/api",
    displayKey: `#${overrides.key}`,
    title: `Issue ${overrides.key}`,
    url: `https://github.com/acme/api/issues/${overrides.key}`,
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

describe("issueFilterScopes", () => {
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
  const tracker = (overrides: Partial<IssueTrackerSummary>): IssueTrackerSummary =>
    ({
      tracker: "linear",
      host: "linear.app",
      projectCount: 1,
      capabilities,
      configured: true,
      detail: null,
      ...overrides,
    }) as IssueTrackerSummary;
  const linearRow = entry({
    key: "ENG-1",
    tracker: "linear" as IssueTrackerKind,
    host: "linear.app",
    scope: "ENG",
  });

  it("offers a bound standalone tracker's scope, named by the rows it listed", () => {
    const held = new Map([
      [
        environmentId,
        {
          answer: answer({
            trackers: [tracker({})],
            entries: [linearRow, { ...linearRow, key: "ENG-2" }],
          }),
          entries: [linearRow, { ...linearRow, key: "ENG-2" }],
        },
      ],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([
      {
        environmentId,
        input: { projectId: api, tracker: "linear", host: "linear.app", scope: "ENG" },
      },
    ]);
  });

  it("skips a tracker that cannot be read", () => {
    const held = new Map([
      [
        environmentId,
        {
          answer: answer({ trackers: [tracker({ configured: false })], entries: [linearRow] }),
          entries: [linearRow],
        },
      ],
    ]);
    expect(issueFilterScopes(held, [])).toEqual([]);
  });

  it("reaches a git host's tracker through the project whose remote is on it", () => {
    const held = new Map([
      [
        environmentId,
        {
          answer: answer({
            trackers: [
              tracker({
                tracker: "github" as IssueTrackerKind,
                host: "github.com",
              }),
            ],
          }),
          entries: [],
        },
      ],
    ]);
    const projects = [
      {
        id: api,
        environmentId,
        repositoryIdentity: {
          canonicalKey: "github.com/acme/api",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/acme/api.git",
          },
          webUrl: "https://github.com/acme/api",
          displayName: "acme/api",
          provider: "github",
        },
      } as unknown as EnvironmentProject,
    ];
    expect(issueFilterScopes(held, projects)).toEqual([
      {
        environmentId,
        input: { projectId: api, tracker: "github", host: "github.com", scope: "acme/api" },
      },
    ]);
  });
});
