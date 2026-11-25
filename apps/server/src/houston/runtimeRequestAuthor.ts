import { CommandId, type OrchestrationV2Command } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type RuntimeRequestRespond = Extract<
  OrchestrationV2Command,
  { readonly type: "runtime-request.respond" }
>;
type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

// Only the server says who answered; a client that names an author could pass as an agent.
const SERVER_ONLY_FIELDS = ["answeredBy", "senderThreadId"] as const;

export class RuntimeRequestAuthorFieldError extends Schema.TaggedError<RuntimeRequestAuthorFieldError>()(
  "RuntimeRequestAuthorFieldError",
  { commandId: CommandId, field: Schema.String },
) {
  override get message(): string {
    return `runtime-request.respond cannot carry ${this.field}: the server records who answered.`;
  }
}

/** A client command as the server records it: a client's answer is the user's. */
export const stampClientAnswer = (
  command: OrchestrationV2Command,
): Effect.Effect<OrchestrationV2Command, RuntimeRequestAuthorFieldError> => {
  if (command.type !== "runtime-request.respond") return Effect.succeed(command);
  const field = SERVER_ONLY_FIELDS.find((name) => command[name] !== undefined);
  return field === undefined
    ? Effect.succeed({ ...command, answeredBy: "user" })
    : Effect.fail(new RuntimeRequestAuthorFieldError({ commandId: command.commandId, field }));
};

// An answer sent as a message is the user's only when the user answered; an agent's reads as a
// houston_thread_send message.
export function asyncAnswerAuthor(
  command: RuntimeRequestRespond,
): Pick<MessageDispatch, "createdBy" | "creationSource" | "senderThreadId"> {
  switch (command.answeredBy) {
    case "user":
      return { createdBy: "user", creationSource: "server" };
    case "agent":
      return {
        createdBy: "agent",
        creationSource: "mcp",
        ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
      };
    default:
      return { createdBy: "agent", creationSource: "server" };
  }
}
