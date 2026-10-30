// The `/ws` JSON serialization. A frame that is not valid JSON is refused with a fixed message:
// the engine's own parse error quotes the frame, which can hold a token being sent.
import * as Layer from "effect/Layer";
import { RpcSerialization } from "effect/rpc";

export const INVALID_FRAME = "the request frame is not valid JSON";

const json = RpcSerialization.json;

export const jsonWithoutEcho = RpcSerialization.RpcSerialization.of({
  ...json,
  makeUnsafe: () => {
    const parser = json.makeUnsafe();
    return {
      ...parser,
      decode: (bytes) => {
        try {
          return parser.decode(bytes);
        } catch {
          throw new Error(INVALID_FRAME);
        }
      },
    };
  },
});

export const layerJsonWithoutEcho = Layer.succeed(RpcSerialization.RpcSerialization)(
  jsonWithoutEcho,
);
