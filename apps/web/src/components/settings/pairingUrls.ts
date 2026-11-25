import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingServerKeyOnUrl, setPairingTokenOnUrl } from "@houston-app/shared/remote";

export function resolveDesktopPairingUrl(
  endpointUrl: string,
  credential: string,
  serverIdentityKey?: string | null,
): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  const withToken = setPairingTokenOnUrl(url, credential);
  // Older clients ignore the unknown hash param; newer ones pin the server's
  // E2EE identity key from it.
  return serverIdentityKey
    ? setPairingServerKeyOnUrl(withToken, serverIdentityKey).toString()
    : withToken.toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
