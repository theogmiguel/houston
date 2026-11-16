export type PreviewAddressSecurity = "secure" | "local" | "not-secure";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const IPV6_BRACKETS = /^\[|\]$/g;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(IPV6_BRACKETS, "");
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith(".localhost");
}

/** The connection label describes the transport, not whether the page content is trustworthy. */
export function previewAddressSecurity(url: string): PreviewAddressSecurity | null {
  if (url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return "secure";
    if (parsed.protocol !== "http:") return null;
    return isLoopbackHostname(parsed.hostname) ? "local" : "not-secure";
  } catch {
    return null;
  }
}

export function previewAddressSecurityLabel(security: PreviewAddressSecurity): string {
  switch (security) {
    case "secure":
      return "Secure";
    case "local":
      return "Local";
    case "not-secure":
      return "Not secure";
  }
}
