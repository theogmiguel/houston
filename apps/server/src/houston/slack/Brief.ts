// What a Slack-filed task's brief carries: the requester's words attributed and fenced, the
// adjustments the owner accepted, and the request's images.
import { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { TaskRow } from "../tasks/TaskStore.ts";
import { defangFences, fenceSlackAdjustments, fenceSlackRequest } from "./rules.ts";

const decodeAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ChatAttachment)),
);

export interface SlackBrief {
  readonly title: string;
  readonly description: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/** The brief's title, description and images for a Slack-filed task; none for any other. */
export const slackBriefOf = Effect.fn("HoustonSlackBrief.of")(function* (
  row: Pick<TaskRow, "id" | "created_by" | "title" | "description">,
) {
  if (!row.created_by.startsWith("slack:")) return Option.none<SlackBrief>();
  const sql = yield* SqlClient.SqlClient;
  const [request] = yield* sql<{
    readonly id: number;
    readonly author: string;
    readonly channel_id: string;
    readonly attachments_json: string | null;
  }>`
    SELECT id, author, channel_id, attachments_json FROM houston_slack_requests
    WHERE task_id = ${row.id} ORDER BY id LIMIT 1
  `.pipe(Effect.orDie);
  if (request === undefined) return Option.none<SlackBrief>();
  const adjustments = yield* sql<{ readonly text: string }>`
    SELECT text FROM houston_slack_adjustments
    WHERE request_id = ${request.id} AND state = 'accepted' ORDER BY id
  `.pipe(Effect.orDie);
  const fenced = fenceSlackRequest({
    author: request.author,
    channel: request.channel_id,
    text: row.description,
  });
  return Option.some<SlackBrief>({
    title: defangFences(row.title),
    description:
      adjustments.length === 0
        ? fenced
        : `${fenced}\n\n${fenceSlackAdjustments(adjustments.map((entry) => entry.text))}`,
    attachments:
      request.attachments_json === null
        ? []
        : Option.getOrElse(decodeAttachments(request.attachments_json), () => []),
  });
});
