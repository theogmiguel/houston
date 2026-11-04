/** A failed host bridge call's message; the desktop host rejects with a plain string. */
export function hostBridgeErrorMessage(cause: unknown, fallback: string): string {
  const message =
    typeof cause === "string" ? cause : cause instanceof Error ? cause.message : undefined;
  return message?.trim() || fallback;
}
