import { isLoopbackHost } from "./preview.ts";

const PROVIDER_AUTH_RETURN_URL_PATTERN = /^#agents:[\w-]+$/u;

export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["houston:", "houston-dev:"].includes(url.protocol) && url.host === "app";
    const web = ["http:", "https:"].includes(url.protocol) && isLoopbackHost(url.hostname);
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !PROVIDER_AUTH_RETURN_URL_PATTERN.test(url.hash))
      url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
