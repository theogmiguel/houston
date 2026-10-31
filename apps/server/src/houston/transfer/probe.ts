// What a transfer reads and where it stands, observable by tests; the server keeps the no-op default.
import type {
  HoustonTransferOperation,
  HoustonTransferStage,
} from "@t3tools/contracts/houston/transfer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface TransferProbeShape {
  /** Each frame a reader decodes, by entry name. */
  readonly onFrame: (name: string) => void;
  /** Each file of a checkout or attachment store the export opens. */
  readonly onFileRead: (path: string) => void;
  /** Runs before a transfer enters `stage`; a test holds a transfer there by not returning. */
  readonly onStage: (
    operation: HoustonTransferOperation,
    stage: HoustonTransferStage,
  ) => Effect.Effect<void>;
}

export const TransferProbe = Context.Reference<TransferProbeShape>(
  "houston/transfer/TransferProbe",
  {
    defaultValue: () => ({
      onFrame: () => undefined,
      onFileRead: () => undefined,
      onStage: () => Effect.void,
    }),
  },
);
