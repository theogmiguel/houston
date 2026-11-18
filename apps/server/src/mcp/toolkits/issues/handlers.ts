import {
  threadIssueKeysEqual,
  OrchestratorMcpFailure,
  type IssueDetail,
  type IssueRef,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SIDE_THREAD_READ_ONLY } from "../../../houston/sideThreads.ts";
import {
  HOUSTON_ISSUE_TOOL_COMMENTS,
  HOUSTON_ISSUE_TOOL_TEXT_BYTES,
  HOUSTON_ISSUE_TOOL_TITLE_CHARS,
  HOUSTON_ISSUE_UNTRUSTED_LABEL,
  IssueLinkFailedError,
  IssueProjectNotFoundError,
  IssueProjectRequiredError,
  IssuesToolkit,
  IssueTargetIncompleteError,
  type IssueTargetInput,
  IssueThreadNotFoundError,
  IssueThreadRequiredError,
  type ListThreadIssuesResult,
} from "./tools.ts";

const TRAILING_REPLACEMENT_CHARS = /�+$/;
const untrusted: typeof HOUSTON_ISSUE_UNTRUSTED_LABEL = HOUSTON_ISSUE_UNTRUSTED_LABEL;

/** Keeps a title or key a label rather than a document. */
const capTitle = (text: string): string =>
  text.length <= HOUSTON_ISSUE_TOOL_TITLE_CHARS
    ? text
    : `${text.slice(0, HOUSTON_ISSUE_TOOL_TITLE_CHARS)}…`;

/** Cuts one string at the byte cap, naming the cap and the full size. */
const capText = (text: string): string => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= HOUSTON_ISSUE_TOOL_TEXT_BYTES) return text;
  const cut = Buffer.from(text, "utf8")
    .subarray(0, HOUSTON_ISSUE_TOOL_TEXT_BYTES)
    .toString("utf8")
    .replace(TRAILING_REPLACEMENT_CHARS, "");
  return `${cut}\n. [cut at ${HOUSTON_ISSUE_TOOL_TEXT_BYTES} bytes; the full text is ${bytes} bytes]`;
};

/** Every text field of a result, however deep, capped. */
const capped = <A>(value: A): A => {
  if (typeof value === "string") return capText(value) as A;
  if (Array.isArray(value)) return value.map(capped) as A;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, capped(field)]),
    ) as A;
  }
  return value;
};

/** A resolved reference, with the host the link stores and whether it may be written. */
interface ResolvedTarget extends IssueRef {
  readonly host: string;
  readonly url: string | null;
  readonly writable: boolean;
}

/** What the tools report from a thread shell; exported so the shape is testable without a layer. */
function listThreadIssues(
  thread: Pick<OrchestrationV2ThreadShell, "issues">,
): ListThreadIssuesResult {
  return {
    untrusted,
    issues: (thread.issues ?? []).map((link) => ({
      projectId: link.projectId,
      tracker: link.tracker,
      host: link.host,
      scope: link.scope,
      key: link.key,
      url: link.url,
      source: link.source,
      displayKey: capTitle(link.displayKey),
      title: capTitle(link.title),
    })),
  };
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const issues = yield* IssueService.IssueService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  /**
   * A side thread is read-only, so an issue write is refused by name. Its credential is normally
   * revoked; this backstops one that outlived that rule.
   */
  const refuseSideThread = Effect.fn("IssuesToolkit.refuseSideThread")(function* (tool: string) {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    if (scope.thread === undefined) return;
    const thread = yield* threads
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (thread?.side === undefined) return;
    const side = thread.side;
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `${tool} refused: ${thread.id} is a side thread (${side.kind} of ${side.sourceThreadId}). ${SIDE_THREAD_READ_ONLY}`,
    });
  });

  /** The caller's own thread, read when a tool defaults to it. */
  const callerThread = Effect.fn("IssuesToolkit.callerThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    return scope.thread === undefined
      ? undefined
      : yield* engine.getThreadShell(scope.thread.threadId).pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((shell) => shell ?? undefined),
        );
  });

  const requireThread = Effect.fn("IssuesToolkit.requireThread")(function* (
    requested: ThreadId | undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("issues");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new IssueThreadRequiredError();
    const thread = yield* engine.getThreadShell(threadId).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.mapError((cause) => new IssueLinkFailedError({ cause })),
    );
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new IssueThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  /** Where a key-only reference is read: the named project's tracker, or the caller's thread's. */
  const requireProjectScope = Effect.fn("IssuesToolkit.requireProjectScope")(function* (
    requested: ProjectId | undefined,
  ) {
    // A named project skips the caller's thread, so the capability is checked here too.
    yield* McpInvocationContext.requireMcpCapability("issues");
    const projectId = requested ?? (yield* callerThread())?.projectId;
    if (projectId === undefined) return yield* new IssueProjectRequiredError();
    return yield* issues
      .projectScope(projectId)
      .pipe(Effect.mapError(() => new IssueProjectNotFoundError({ projectId })));
  });

  /**
   * Turns whichever shape the agent passed into one reference. A URL resolves through whichever
   * project here is a checkout of its repository; a key is completed with the named project's
   * binding, or the caller's thread's project.
   */
  const resolveTarget = Effect.fn("IssuesToolkit.resolveTarget")(function* (
    input: IssueTargetInput,
  ) {
    yield* McpInvocationContext.requireMcpCapability("issues");
    if (input.url !== undefined) {
      const preferred = input.projectId ?? (yield* callerThread())?.projectId;
      const resolved = yield* issues.resolveUrl(input.url, preferred);
      return { ...resolved, url: input.url } satisfies ResolvedTarget;
    }
    if (input.key === undefined) return yield* new IssueTargetIncompleteError();
    const scope = yield* requireProjectScope(input.projectId);
    return {
      ...scope,
      key: input.key,
      url: null,
      writable: true,
    } satisfies ResolvedTarget;
  });

  const identityOf = (target: ResolvedTarget, detail?: Pick<IssueDetail, "url">) => ({
    projectId: target.projectId,
    tracker: target.tracker,
    host: target.host,
    scope: target.scope,
    key: target.key,
    url: target.url ?? detail?.url ?? "",
  });

  const refOf = (target: ResolvedTarget): IssueRef & { readonly host: string } => ({
    projectId: target.projectId,
    tracker: target.tracker,
    host: target.host,
    scope: target.scope,
    key: target.key,
  });

  /** A link needs the issue's URL, which a key-only reference does not carry; one read fills it. */
  const linkFailure = <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new IssueLinkFailedError({ cause }));

  /** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    list_issues: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projectId } = yield* requireProjectScope(input.projectId);
        const result = yield* issues.list({
          projectId,
          state: input.state ?? "open",
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursors === undefined ? {} : { cursors: input.cursors }),
        });
        return {
          untrusted,
          issues: capped(
            result.entries.map((entry) => ({
              projectId: entry.projectId,
              tracker: entry.tracker,
              host: entry.host,
              scope: entry.scope,
              key: entry.key,
              url: entry.url,
              displayKey: capTitle(entry.displayKey),
              title: capTitle(entry.title),
              state: entry.state,
              author: entry.author?.login ?? null,
              assignees: entry.assignees.map((actor) => actor.login),
              labels: entry.labels.map((label) => label.name),
              updatedAt: entry.updatedAt,
              commentCount: entry.commentCount,
            })),
          ),
          nextCursors: result.nextCursors,
          errors: result.errors.map((error) => ({
            projectId: error.projectId,
            message: capText(error.message),
          })),
        };
      }),
    ),
    read_issue: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const detail = yield* issues.detail(refOf(target));
        const comments = detail.comments.slice(-HOUSTON_ISSUE_TOOL_COMMENTS);
        return {
          untrusted,
          ...identityOf(target, detail),
          displayKey: capTitle(detail.displayKey),
          title: capTitle(detail.title),
          state: detail.state,
          writable: detail.writable,
          capabilities: detail.capabilities,
          states: detail.states,
          author: detail.author?.login ?? null,
          assignees: detail.assignees.map((actor) => actor.login),
          labels: detail.labels.map((label) => label.name),
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          closedAt: detail.closedAt,
          body: capText(detail.body),
          comments: comments.map((comment) => ({
            id: comment.id,
            author: comment.author?.login ?? null,
            body: capText(comment.body),
            createdAt: comment.createdAt,
          })),
          commentsTruncated:
            detail.commentsCursor !== null || comments.length < detail.comments.length,
          linkedPullRequests: capped(
            detail.linkedPullRequests.map((pullRequest) => ({
              url: pullRequest.url,
              title: capTitle(pullRequest.title),
              state: pullRequest.state,
              closesIssue: pullRequest.closesIssue,
            })),
          ),
        };
      }),
    ),
    create_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        yield* refuseSideThread("create_issue");
        const scope = yield* requireProjectScope(input.projectId);
        const created = yield* issues.create({
          ...scope,
          title: input.title,
          body: input.body ?? "",
          labels: input.labels ?? [],
          assignees: input.assignees ?? [],
        });
        return {
          ...scope,
          key: created.key,
          url: created.url,
          displayKey: capTitle(created.displayKey),
        };
      }),
    ),
    comment_on_issue: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        yield* refuseSideThread("comment_on_issue");
        const target = yield* resolveTarget(input);
        yield* issues.comment({ ...refOf(target), body: input.body });
        return identityOf(target);
      }),
    ),
    set_issue_state: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        yield* refuseSideThread("set_issue_state");
        const target = yield* resolveTarget(input);
        yield* issues.setState({
          ...refOf(target),
          state: input.state,
        });
        return identityOf(target);
      }),
    ),
    link_issue: writesThread((input) =>
      Effect.gen(function* () {
        yield* refuseSideThread("link_issue");
        const thread = yield* requireThread(input.threadId);
        const target = yield* resolveTarget({
          ...input,
          projectId: input.projectId ?? thread.projectId,
        });
        // Reading the issue proves it exists and names it for the thread's row.
        const detail = yield* issues.detail(refOf(target));
        const url = target.url ?? detail.url;
        const { alreadyLinked } = yield* threadIssues
          .link({
            threadId: thread.id,
            ref: refOf(target),
            url,
            displayKey: detail.displayKey,
            title: detail.title,
            source: "agent",
          })
          .pipe(Effect.catchCause(linkFailure));
        return { ...identityOf(target), url, alreadyLinked };
      }),
    ),
    unlink_issue: writesThread((input) =>
      Effect.gen(function* () {
        yield* refuseSideThread("unlink_issue");
        const thread = yield* requireThread(input.threadId);
        const target = yield* resolveTarget({
          ...input,
          projectId: input.projectId ?? thread.projectId,
        });
        const existing = (thread.issues ?? []).find((link) => threadIssueKeysEqual(link, target));
        if (existing === undefined) return { ...identityOf(target), wasLinked: false };
        const { wasLinked } = yield* threadIssues
          .unlink({ threadId: thread.id, key: target })
          .pipe(Effect.catchCause(linkFailure));
        return { ...identityOf(target), url: existing.url, wasLinked };
      }),
    ),
    list_thread_issues: McpToolAccess.reads((input) =>
      requireThread(input.threadId).pipe(Effect.map(listThreadIssues)),
    ),
  } satisfies McpToolAccess.Handlers<typeof IssuesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(IssuesToolkit, make);
