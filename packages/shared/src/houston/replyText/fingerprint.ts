// The hash of what was shown, compared by the send. sha256 from a library, not Web Crypto,
// which is missing on plain-HTTP pages; the same in the server and the renderer.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { stableStringify } from "../../stableStringify.ts";
import type { ReplyBlocks, ReplyPerson } from "./structure.ts";

export interface ReplyFingerprintInput {
  readonly connectionId: string;
  readonly conversationId: string;
  /** The thread's root `ts`, or `""` for the conversation's top level. */
  readonly rootTs: string;
  readonly draftId: string;
  readonly blocks: ReplyBlocks;
  readonly text: string;
  readonly people: ReadonlyArray<ReplyPerson>;
}

export const replyFingerprint = (input: ReplyFingerprintInput): string =>
  bytesToHex(
    sha256(
      new TextEncoder().encode(
        stableStringify({
          v: 1,
          connectionId: input.connectionId,
          conversationId: input.conversationId,
          rootTs: input.rootTs,
          draftId: input.draftId,
          blocks: input.blocks,
          text: input.text,
          people: input.people.map((person) => ({ id: person.id, name: person.name })),
        }),
      ),
    ),
  );
