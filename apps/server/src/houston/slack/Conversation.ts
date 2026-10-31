// A Slack run's side of its thread: the agent asks one question at a time and hands its result
// back; the first answer from the requester or the owner reaches the run once (AD-066).
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonSlackError, HoustonSlackLanguage } from "@t3tools/contracts/houston/slack";
import {
  houstonTaskKey,
  type HoustonTask,
  type HoustonTaskError,
} from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../../project/ProjectService.ts";
import { HoustonTaskRuns } from "../tasks/TaskRuns.ts";
import { HoustonTaskService } from "../tasks/TaskService.ts";
import { HoustonTaskStore, nowIso, type RunRow, type TaskRow } from "../tasks/TaskStore.ts";
import { OPEN_RUN_STATES } from "../tasks/rules.ts";
import {
  agentText,
  answerAllowed,
  checkQuestionForm,
  checkResultForm,
  escapeMrkdwn,
  fenceSlackAnswer,
  refuse,
  type QuestionForm,
  type ResultForm,
} from "./rules.ts";
import { SLACK_ANSWER_ALREADY_SENT, SLACK_ANSWER_NEEDS_LIVE_THREAD } from "../slackAnswer.ts";
import { HoustonSlackRunMessages } from "./RunMessages.ts";
import { HoustonSlackStore } from "./Store.ts";
import { slackText } from "./text.ts";

export const ANSWER_ACTION = "houston_slack_answer";
export const OTHER_ANSWER_ACTION = "houston_slack_answer_other";
export const ANSWER_CALLBACK = "houston_slack_answer";
const ASK = "houston_slack_ask";
const HANDBACK = "houston_slack_handback";
/** Slack's limit for a button label. */
const BUTTON_CHARS = 75;

const QuestionFormJson = Schema.fromJsonString(
  Schema.Struct({
    context: Schema.String,
    question: Schema.String,
    options: Schema.Array(Schema.String),
    recommended: Schema.Number,
    why: Schema.optional(Schema.String),
  }),
);
const encodeQuestion = Schema.encodeSync(QuestionFormJson);
const decodeQuestion = Schema.decodeUnknownSync(QuestionFormJson);
const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export type AnswerOutcome = "answered" | "already" | "not_allowed" | "missing";

export class HoustonSlackConversation extends Context.Service<
  HoustonSlackConversation,
  {
    /** `houston_slack_ask` from `threadId`, which must be the open run of a Slack-filed task. */
    readonly ask: (
      threadId: string,
      form: QuestionForm,
    ) => Effect.Effect<{ readonly questionId: number }, HoustonSlackError>;
    /** `houston_slack_handback`: the form is recorded and the task handed back. */
    readonly handback: (
      threadId: string,
      form: ResultForm,
    ) => Effect.Effect<HoustonTask, HoustonSlackError | HoustonTaskError>;
    /** `user`'s answer to `questionId`; only the first answer from the requester or owner counts. */
    readonly answer: (
      questionId: number,
      user: string,
      value: string,
      ts?: string,
    ) => Effect.Effect<AnswerOutcome>;
    /** The open question of a request, if any. */
    readonly openQuestion: (requestId: number) => Effect.Effect<number | undefined>;
    /** Sends each answer not yet delivered to its run's thread. */
    readonly deliverAnswers: Effect.Effect<void>;
  }
>()("houston/houston/slack/Conversation/HoustonSlackConversation") {}

interface QuestionRow {
  readonly id: number;
  readonly request_id: number;
  readonly task_run_id: number;
  readonly thread_id: string;
  readonly form_json: string;
  readonly answer: string | null;
  readonly answered_by: string | null;
  readonly answered_at: string | null;
}

export const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

const buttonLabel = (value: string) =>
  [...value].length <= BUTTON_CHARS ? value : `${[...value].slice(0, BUTTON_CHARS - 1).join("")}…`;

/** The workspace root of `projectId`, cut out of everything an agent posts; null if unknown. */
export const projectRootOf = (projectId: string) =>
  Effect.flatMap(ProjectService.ProjectService, (projects) =>
    projects.getById(projectId as ProjectId).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: (project) => project.workspaceRoot })),
      Effect.orElseSucceed(() => null),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonSlackStore;
  const taskStore = yield* HoustonTaskStore;
  const runs = yield* HoustonTaskRuns;
  const tasks = yield* HoustonTaskService;
  const projects = yield* ProjectService.ProjectService;
  const messages = yield* HoustonSlackRunMessages;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const rootOf = (projectId: string) =>
    projectRootOf(projectId).pipe(Effect.provideService(ProjectService.ProjectService, projects));

  const language = Effect.map(
    store.settings,
    (settings): HoustonSlackLanguage => settings?.language ?? "en",
  );

  /** The caller's run, when it is the open implementation run of a started Slack request. */
  const slackRunOf = Effect.fn("HoustonSlackConversation.slackRunOf")(function* (
    operation: string,
    threadId: string,
  ) {
    const [found] = yield* run(sql<{ readonly run_id: number; readonly request_id: number }>`
      SELECT tr.id AS run_id, r.id AS request_id
      FROM houston_task_runs tr
      JOIN houston_tasks t ON t.id = tr.task_id
      JOIN houston_slack_requests r ON r.task_id = tr.task_id
      WHERE tr.thread_id = ${threadId} AND tr.kind = 'implementation'
        AND t.created_by LIKE 'slack:%' AND r.state = 'started'
        AND tr.id = (
          SELECT MAX(id) FROM houston_task_runs
          WHERE task_id = tr.task_id AND kind = 'implementation'
        )
      ORDER BY r.id LIMIT 1
    `);
    const runRow =
      found === undefined
        ? undefined
        : (yield* run(sql<RunRow>`SELECT * FROM houston_task_runs WHERE id = ${found.run_id}`))[0];
    const request = found === undefined ? undefined : yield* store.requestById(found.request_id);
    const task = runRow === undefined ? undefined : yield* taskStore.taskById(runRow.task_id);
    if (
      runRow === undefined ||
      request === undefined ||
      task === undefined ||
      !OPEN_RUN_STATES.has(runRow.state)
    ) {
      return yield* refuse(
        "not_slack",
        operation,
        `thread ${threadId} is not the open run of a Slack-filed task; the Slack tools work only there`,
      );
    }
    return { run: runRow, request, task };
  });

  const contextOf = (task: TaskRow, runRow: RunRow) =>
    Effect.map(rootOf(task.project_id ?? ""), (root) => ({
      root,
      hide: [houstonTaskKey(task.number), runRow.branch ?? ""],
    }));

  const openQuestion = (requestId: number) =>
    run(sql<{ readonly id: number }>`
      SELECT id FROM houston_slack_questions WHERE request_id = ${requestId} AND answered_at IS NULL
      ORDER BY id LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]?.id));

  const questionText = (
    form: QuestionForm,
    clean: (value: string) => string,
    text: ReturnType<typeof slackText>,
  ) =>
    [
      ...(form.context.trim().length === 0 ? [] : [clean(form.context)]),
      `*${clean(form.question)}*`,
      ...form.options.map(
        (option, index) =>
          `${index + 1}. ${clean(option)}${index === form.recommended ? ` _(${text.recommended})_` : ""}`,
      ),
      ...(form.why === undefined || form.why.trim().length === 0 ? [] : [`_${clean(form.why)}_`]),
    ].join("\n");

  const ask: HoustonSlackConversation["Service"]["ask"] = Effect.fn("HoustonSlackConversation.ask")(
    function* (threadId, form) {
      const refusal = checkQuestionForm(ASK, form);
      if (refusal !== undefined) return yield* refusal;
      const caller = yield* slackRunOf(ASK, threadId);
      const text = slackText(yield* language);
      const context = yield* contextOf(caller.task, caller.run);
      const clean = (value: string) => agentText(value, context);
      const now = yield* nowIso;
      const questionId = yield* store.write(
        Effect.gen(function* () {
          const open = yield* openQuestion(caller.request.id);
          if (open !== undefined) {
            return yield* refuse(
              "busy",
              ASK,
              `question ${open} is still open in the Slack thread; wait for its answer before asking another`,
            );
          }
          const [row] = yield* run(sql<{ readonly id: number }>`
            INSERT INTO houston_slack_questions (
              request_id, task_run_id, thread_id, form_json, created_at
            ) VALUES (
              ${caller.request.id}, ${caller.run.id}, ${threadId}, ${encodeQuestion(form)}, ${now}
            ) RETURNING id
          `);
          const id = row?.id ?? 0;
          yield* store.react(caller.request.id, "question");
          const body = `${questionText(form, clean, text)}\n${text.questionHint}`;
          yield* store.enqueue({
            requestId: caller.request.id,
            dedupeKey: `question:${id}`,
            target: "thread",
            text: body,
            blocks: [
              section(body),
              {
                type: "actions",
                elements: [
                  ...form.options.map((option, index) => ({
                    type: "button",
                    action_id: `${ANSWER_ACTION}_${index}`,
                    value: `${id}:${index}`,
                    text: { type: "plain_text", text: buttonLabel(`${index + 1}. ${clean(option)}`) },
                    ...(index === form.recommended ? { style: "primary" } : {}),
                  })),
                  {
                    type: "button",
                    action_id: OTHER_ANSWER_ACTION,
                    value: String(id),
                    text: { type: "plain_text", text: text.otherAnswer },
                  },
                ],
              },
            ],
            messageTs: caller.request.ts,
          });
          return { result: id, requests: [caller.request.id], touched: [caller.task.id] };
        }),
      );
      return { questionId };
    },
  );

  const deliverAnswers = Effect.gen(function* () {
    const pending = yield* run(sql<QuestionRow & { readonly author: string }>`
      SELECT q.*, r.author AS author FROM houston_slack_questions q
      JOIN houston_slack_requests r ON r.id = q.request_id
      WHERE q.answered_at IS NOT NULL AND q.delivered_at IS NULL ORDER BY q.id
    `);
    for (const question of pending) {
      const who = question.answered_by === question.author ? "requester" : "owner";
      const sent = yield* Effect.result(
        messages.deliver({
          threadId: question.thread_id,
          questionId: question.id,
          text: fenceSlackAnswer(who, question.answer ?? ""),
        }),
      );
      // A thread that already has the answer, or can no longer take one, is done with it.
      const done =
        sent._tag === "Success" ||
        sent.failure === SLACK_ANSWER_ALREADY_SENT ||
        sent.failure === SLACK_ANSWER_NEEDS_LIVE_THREAD;
      if (sent._tag === "Failure") {
        yield* Effect.logWarning(`Slack answer ${question.id} not delivered: ${sent.failure}`);
      }
      if (done) {
        const now = yield* nowIso;
        yield* run(sql`
          UPDATE houston_slack_questions SET delivered_at = ${now} WHERE id = ${question.id}
        `);
      }
    }
  });

  const answer: HoustonSlackConversation["Service"]["answer"] = Effect.fn(
    "HoustonSlackConversation.answer",
  )(function* (questionId, user, value, ts) {
    const [question] = yield* run(sql<QuestionRow>`
      SELECT * FROM houston_slack_questions WHERE id = ${questionId}
    `);
    if (question === undefined) return "missing";
    const request = yield* store.requestById(question.request_id);
    if (request === undefined) return "missing";
    const settings = yield* store.settings;
    if (
      !answerAllowed({
        user,
        requester: request.author,
        ownerUserId: settings?.owner_user_id ?? null,
      })
    ) {
      return "not_allowed";
    }
    if (question.answered_at !== null) return "already";
    const text = slackText(settings?.language ?? "en");
    const runRow = (yield* run(sql<RunRow>`
      SELECT * FROM houston_task_runs WHERE id = ${question.task_run_id}
    `))[0];
    const task = runRow === undefined ? undefined : yield* taskStore.taskById(runRow.task_id);
    const context =
      task === undefined || runRow === undefined
        ? { root: null, hide: [] }
        : yield* contextOf(task, runRow);
    const form = decodeQuestion(question.form_json);
    const now = yield* nowIso;
    const outcome = yield* store.write(
      Effect.gen(function* () {
        const updated = yield* run(sql<{ readonly id: number }>`
          UPDATE houston_slack_questions SET answer = ${value}, answered_by = ${user},
            answer_ts = ${ts ?? null}, answered_at = ${now}
          WHERE id = ${questionId} AND answered_at IS NULL RETURNING id
        `);
        if (updated.length === 0) return { result: "already" as const };
        yield* store.react(request.id, "gear");
        const body = [
          questionText(form, (field) => agentText(field, context), text),
          `${text.answerLabel}: ${escapeMrkdwn(value)}`,
          `_${text.answeredBy(user)}_`,
        ].join("\n");
        yield* store.enqueue({
          requestId: request.id,
          dedupeKey: `question-answered:${questionId}`,
          target: "update",
          text: body,
          blocks: [section(body)],
          updateOf: `question:${questionId}`,
        });
        return {
          result: "answered" as const,
          requests: [request.id],
          touched: task === undefined ? [] : [task.id],
        };
      }),
    );
    if (outcome === "answered") yield* deliverAnswers;
    return outcome;
  });

  const handback: HoustonSlackConversation["Service"]["handback"] = Effect.fn(
    "HoustonSlackConversation.handback",
  )(function* (threadId, form) {
    const refusal = checkResultForm(HANDBACK, form);
    if (refusal !== undefined) return yield* refusal;
    const caller = yield* slackRunOf(HANDBACK, threadId);
    const key = houstonTaskKey(caller.task.number);
    yield* runs.handback(
      { id: key, summary: `${form.subject.trim()}\n\n${form.changes.trim()}` },
      `agent:${threadId}`,
    );
    const now = yield* nowIso;
    yield* store.write(
      run(sql`
        INSERT INTO houston_slack_results (task_run_id, request_id, form_json, created_at)
        VALUES (${caller.run.id}, ${caller.request.id}, ${encodeResult(form)}, ${now})
        ON CONFLICT (task_run_id) DO NOTHING
      `).pipe(
        Effect.as({ result: undefined, requests: [caller.request.id], touched: [caller.task.id] }),
      ),
    );
    return (yield* tasks.get({ id: key })).task;
  });

  return HoustonSlackConversation.of({ ask, handback, answer, openQuestion, deliverAnswers });
});

export const layer = Layer.effect(HoustonSlackConversation, make);
