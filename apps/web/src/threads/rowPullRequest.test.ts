import { describe, expect, it } from "vite-plus/test";

import { resolveRowPullRequest } from "./rowPullRequest";

describe("resolveRowPullRequest", () => {
  function link(
    number: number,
    state: "open" | "merged" | "closed",
    extra: { isDraft?: boolean; updatedAt?: string | null; checksState?: string } = {},
  ) {
    return {
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      linkedAt: "2026-10-01T00:00:00.000Z",
      snapshot: {
        state,
        title: `PR ${number}`,
        isDraft: extra.isDraft ?? false,
        updatedAt: extra.updatedAt ?? "2026-10-02T00:00:00.000Z",
        ...(extra.checksState === undefined ? {} : { checksState: extra.checksState }),
      },
    } as never;
  }

  it("prefers open over draft over merged over closed", () => {
    const pullRequests = [
      link(1, "closed"),
      link(2, "merged"),
      link(3, "open", { isDraft: true }),
      link(4, "open"),
    ];
    expect(resolveRowPullRequest({ pullRequests, branchPullRequest: null })?.number).toBe(4);
    expect(
      resolveRowPullRequest({ pullRequests: pullRequests.slice(0, 3), branchPullRequest: null }),
    ).toMatchObject({ number: 3, state: "draft" });
    expect(
      resolveRowPullRequest({ pullRequests: pullRequests.slice(0, 2), branchPullRequest: null }),
    ).toMatchObject({ number: 2, state: "merged" });
  });

  it("shows a merged pull request", () => {
    const thread = { pullRequests: [link(7, "merged")], branchPullRequest: null };
    expect(resolveRowPullRequest(thread)).toMatchObject({
      number: 7,
      state: "merged",
      title: "PR 7",
    });
  });

  it("picks the most recently updated pull request within a state", () => {
    const thread = {
      pullRequests: [
        link(1, "merged", { updatedAt: "2026-10-01T00:00:00.000Z" }),
        link(2, "merged", { updatedAt: "2026-10-05T00:00:00.000Z" }),
      ],
      branchPullRequest: null,
    };
    expect(resolveRowPullRequest(thread)?.number).toBe(2);
  });

  it("reports the checks state of the chosen pull request", () => {
    const thread = {
      pullRequests: [link(9, "open", { checksState: "failing" })],
      branchPullRequest: null,
    };
    expect(resolveRowPullRequest(thread)?.checksState).toBe("failing");
  });

  it("falls back to the branch pull request without a state", () => {
    const branchPullRequest = {
      projectId: "project-1",
      repository: "acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
    } as never;
    expect(resolveRowPullRequest({ pullRequests: [], branchPullRequest })).toEqual({
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      state: null,
      title: null,
      checksState: null,
    });
    expect(resolveRowPullRequest({ pullRequests: [], branchPullRequest: null })).toBeNull();
  });
});
