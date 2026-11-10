import {
  createMcpApprovalCodeCommand,
  createPeerPairingCodeCommand,
} from "@houston-app/client-runtime/state/peerPairingCode";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import type { AuthMcpClientAccess, EnvironmentId } from "@houston-app/contracts";
import * as Result from "effect/Result";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const mintPairingCode = createPeerPairingCodeCommand(connectionAtomRuntime);
const mintMcpApprovalCode = createMcpApprovalCodeCommand(connectionAtomRuntime);

/**
 * A fresh pairing code minted on `environmentId` with this client's session
 * there, for linking with `access`. Fails with `PeerPairingCodeError` when the
 * session may not create one.
 */
export async function mintPairingCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
): Promise<Result.Result<string, unknown>> {
  const result = await mintPairingCode.run(appAtomRegistry, { environmentId, input: access });
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}

/**
 * A code minted on `environmentId` that approves one agent sign-in at `access`, with when it
 * expires. Fails with `PeerPairingCodeError` when the session may not create one.
 */
export async function mintMcpApprovalCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
): Promise<Result.Result<{ readonly credential: string; readonly expiresAtMs: number }, unknown>> {
  const result = await mintMcpApprovalCode.run(appAtomRegistry, { environmentId, input: access });
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}
