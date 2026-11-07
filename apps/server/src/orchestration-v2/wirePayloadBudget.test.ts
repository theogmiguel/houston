import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2ThreadStreamItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ResponseStreamingMode,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@houston-app/contracts";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { makeLiveBodyDeduper, projectDomainEventForWire } from "./WireProjection.ts";

// Composed fixture: a fixed 400-word answer in seven paragraphs (2,215 characters), streamed one
// word every 15 ms through a 50 ms text flush and each response streaming mode, then encoded as the
// thread stream sends it to a client that accepts deduped bodies. Only the answer's message and
// turn-item updates are counted, not the node, run and provider-thread updates of a real turn.
const ANSWER_WORDS = 400;
const WORD_INTERVAL_MS = 15;
// Mirrors ACP_TEXT_FLUSH_INTERVAL in packages/provider-acp/src/server/adapter.ts.
const ADAPTER_FLUSH_MS = 50;

// Observed (paragraph mode): 6 streamed updates plus the final one, 31,075 payload bytes, at most
// 1,898 envelope bytes per item (all but the text). Whole-text updates grow quadratically, so a
// finer cadence or a new per-event field fails these ceilings (about 10% above); a new mode must
// meet them or change them on purpose. The ids are fixed, so the envelope ceiling does not guard
// the length of real ids.
const TURN_BUDGET = {
  streamedUpdates: 6,
  payloadBytes: 34_000,
  envelopeBytesPerItem: 2_090,
};

const VOCABULARY = (
  "the server streams each answer to the renderer over one WebSocket and the client applies " +
  "every update to its projection before React paints `message.updated` with **bold** text, " +
  "lists, and code such as `const x = 1;` so measurements reflect real markdown answers. "
).split(/(?<= )/u);

function answerChunks(): ReadonlyArray<string> {
  const chunks: string[] = [];
  for (let index = 0; index < ANSWER_WORDS; index += 1) {
    chunks.push(VOCABULARY[(index * 7 + 1) % VOCABULARY.length]!);
    if (index % 60 === 59) chunks.push("\n\n");
  }
  return chunks;
}

// IDs in the shape the ACP adapter and orchestration produce: they dominate the envelope.
const thread = "ae072fd5-d340-480d-95e3-d561a119f2c1";
const native = "provider-instance%3AwireAgent%3A18ff2530-9d6e-4cee-87e5-ef3eb692d38d%3Aturn%3A1";
const ids = {
  threadId: ThreadId.make(thread),
  runId: RunId.make(`run:thread:${thread}:ordinal:1`),
  nodeId: NodeId.make(`node:provider:acpRegistry:native-item:${native}%3Aassistant%3A0`),
  messageId: MessageId.make(`message:provider:acpRegistry:native-item:${native}%3Aassistant%3A0`),
  turnItemId: TurnItemId.make(
    `turn-item:provider:acpRegistry:native-item:${native}%3Aassistant%3A0`,
  ),
  providerThreadId: ProviderThreadId.make(
    `provider-thread:provider:acpRegistry:native-thread:pending%3Arun%3Athread%3A${thread}%3Aordinal%3A1`,
  ),
  providerTurnId: ProviderTurnId.make(`provider-turn:provider:acpRegistry:native-turn:${native}`),
};
const driver = ProviderDriverKind.make("acpRegistry");
const providerInstanceId = ProviderInstanceId.make("wireAgent");
const at = (ms: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 6, 23, 27, 32) + ms);

function adapterEvents(text: string, ms: number, streaming: boolean) {
  const message = {
    createdBy: "agent" as const,
    creationSource: "provider" as const,
    id: ids.messageId,
    threadId: ids.threadId,
    runId: ids.runId,
    nodeId: ids.nodeId,
    role: "assistant" as const,
    text,
    attachments: [],
    streaming,
    createdAt: at(0),
    updatedAt: at(ms),
  };
  const turnItem = {
    id: ids.turnItemId,
    threadId: ids.threadId,
    runId: ids.runId,
    nodeId: ids.nodeId,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.providerTurnId,
    nativeItemRef: {
      driver,
      nativeId: "18ff2530-9d6e-4cee-87e5-ef3eb692d38d:turn:1:assistant:0",
      strength: "weak" as const,
    },
    parentItemId: null,
    ordinal: 1_000_003,
    status: streaming ? ("running" as const) : ("completed" as const),
    title: null,
    startedAt: at(0),
    completedAt: streaming ? null : at(ms),
    updatedAt: at(ms),
    type: "assistant_message" as const,
    messageId: ids.messageId,
    text,
    streaming,
  };
  return [
    { type: "message.updated", driver, message },
    { type: "turn_item.updated", driver, turnItem },
  ] as unknown as ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
}

function domainEvent(
  event: ProviderAdapter.ProviderAdapterV2Event,
  sequence: number,
  ms: number,
): OrchestrationV2DomainEvent {
  const common = {
    id: EventId.make(
      `event:thread:${thread}:provider-session:provider-session%3Aprovider-instance%3AwireAgent%3Athread%3A${thread}%3Af38fbdcd-87ae-4e06-aedc-f90b09f35b4d:${sequence}`,
    ),
    threadId: ids.threadId,
    runId: ids.runId,
    nodeId: ids.nodeId,
    driver,
    providerInstanceId,
    occurredAt: at(ms),
  };
  if (event.type === "message.updated")
    return { ...common, type: "message.updated", payload: event.message };
  if (event.type === "turn_item.updated")
    return { ...common, type: "turn-item.updated", payload: event.turnItem };
  throw new Error(`Unexpected adapter event ${event.type}`);
}

const encodeItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

it.each(ResponseStreamingMode.literals)(
  "keeps a streamed answer's thread-stream payload and envelopes within budget (%s)",
  (mode) => {
    const filter = makeAssistantStreamingFilter(mode);
    const dedupe = makeLiveBodyDeduper();
    const wireItems: Array<{ readonly bytes: number; readonly textBytes: number }> = [];
    let sequence = 0;
    let streamedUpdates = 0;
    const deliver = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>, ms: number) => {
      for (const event of events) {
        const passed = filter(event, ms);
        if (passed === null) continue;
        sequence += 1;
        const domain = domainEvent(passed, sequence, ms);
        if (domain.type === "message.updated" && domain.payload.streaming) streamedUpdates += 1;
        const item = dedupe({ kind: "event", sequence, event: projectDomainEventForWire(domain) });
        const json = JSON.stringify(encodeItem(item));
        const text =
          item.kind === "event" &&
          (item.event.type === "message.updated" || item.event.type === "turn-item.updated") &&
          "text" in item.event.payload
            ? item.event.payload.text
            : "";
        wireItems.push({
          bytes: Buffer.byteLength(json),
          textBytes: Buffer.byteLength(JSON.stringify(text)) - 2,
        });
      }
    };

    let text = "";
    let flushedAt = -Infinity;
    let pending = false;
    const chunks = answerChunks();
    chunks.forEach((chunk, index) => {
      const ms = (index + 1) * WORD_INTERVAL_MS;
      text += chunk;
      pending = true;
      if (ms - flushedAt >= ADAPTER_FLUSH_MS) {
        deliver(adapterEvents(text, ms, true), ms);
        flushedAt = ms;
        pending = false;
      }
    });
    const endMs = (chunks.length + 1) * WORD_INTERVAL_MS;
    if (pending) deliver(adapterEvents(text, endMs, true), endMs);
    deliver(adapterEvents(text, endMs, false), endMs);

    assert.equal(text.length, 2_215);
    const payloadBytes = wireItems.reduce((total, item) => total + item.bytes, 0);
    const envelopeBytesPerItem = Math.max(...wireItems.map((item) => item.bytes - item.textBytes));
    const observed = { streamedUpdates, payloadBytes, envelopeBytesPerItem };
    for (const metric of Object.keys(TURN_BUDGET) as Array<keyof typeof TURN_BUDGET>) {
      assert.isAtMost(
        observed[metric],
        TURN_BUDGET[metric],
        `${mode}: ${metric} was ${observed[metric]}, maximum ${TURN_BUDGET[metric]}`,
      );
    }
  },
);
