// The parts of the E2EE protocol a client needs before it knows whether a session is encrypted.
// They stay apart from `socketE2ee.ts` so a renderer loads the cipher code only for an
// environment that pinned a key.

/** Query parameter that asks for an E2EE session, mirroring `frameParts`. */
export const SOCKET_E2EE_QUERY_PARAM = "e2ee";

export const E2EE_IDENTITY_MISMATCH_CODE = "E2EE_IDENTITY_MISMATCH";
export const E2EE_REQUIRED_CODE = "E2EE_REQUIRED";

/** Bytes in an Ed25519 or X25519 public key. */
export const E2EE_KEY_LENGTH = 32;

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const TRAILING_PADDING = /=+$/;

// Unpadded base64url (RFC 4648 §5) on the platform's atob/btoa, so this module stays tiny.
export const encodeIdentityKey = (publicKey: Uint8Array): string =>
  btoa(String.fromCharCode(...publicKey))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(TRAILING_PADDING, "");

export const decodeIdentityKey = (value: string): Uint8Array | undefined => {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return bytes.length === E2EE_KEY_LENGTH ? bytes : undefined;
  } catch {
    return undefined;
  }
};
