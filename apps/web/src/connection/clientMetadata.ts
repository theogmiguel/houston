import type {
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
  ClientOs,
  HostBridge,
} from "@houston-app/contracts";

const IS_IPADOS_DESKTOP_USER_AGENT_PATTERN = /macintosh/i;
const IS_IPADOS_DESKTOP_USER_AGENT_PATTERN_2 = /mac/i;
const BROWSER_CLIENT_OS_PATTERN = /iphone|ipad|ipod/i;
const BROWSER_CLIENT_OS_PATTERN_2 = /android/i;
const BROWSER_CLIENT_OS_PATTERN_3 = /cros/i;
const BROWSER_CLIENT_OS_PATTERN_4 = /windows/i;
const BROWSER_CLIENT_OS_PATTERN_5 = /macintosh|mac os x/i;
const BROWSER_CLIENT_OS_PATTERN_6 = /linux|x11/i;
const BROWSER_FAMILY_PATTERN = /edg(?:e|a|ios)?\//i;
const BROWSER_FAMILY_PATTERN_2 = /opr\/|opios\//i;
const BROWSER_FAMILY_PATTERN_3 = /samsungbrowser\//i;
const BROWSER_FAMILY_PATTERN_4 = /firefox\/|fxios\//i;
const BROWSER_FAMILY_PATTERN_5 = /chrome\/|crios\//i;
const BROWSER_FAMILY_PATTERN_6 = /safari\//i;
const BROWSER_DEVICE_TYPE_PATTERN = /ipad|tablet|kindle|silk/i;
const BROWSER_DEVICE_TYPE_PATTERN_2 = /mobile/i;
const BROWSER_DEVICE_TYPE_PATTERN_3 = /iphone|ipod|android.+mobile|mobile/i;

interface BrowserIdentity {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

function clientOsFromElectronPlatform(platform: string | undefined): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform ? "other" : "unknown";
  }
}

function isIpadosDesktopUserAgent(identity: BrowserIdentity): boolean {
  return (
    IS_IPADOS_DESKTOP_USER_AGENT_PATTERN.test(identity.userAgent) &&
    IS_IPADOS_DESKTOP_USER_AGENT_PATTERN_2.test(identity.platform) &&
    identity.maxTouchPoints > 1
  );
}

function browserClientOs(identity: BrowserIdentity): ClientOs {
  const userAgent = identity.userAgent;
  if (userAgent.trim() === "") return "unknown";
  if (BROWSER_CLIENT_OS_PATTERN.test(userAgent) || isIpadosDesktopUserAgent(identity)) return "iOS";
  if (BROWSER_CLIENT_OS_PATTERN_2.test(userAgent)) return "Android";
  if (BROWSER_CLIENT_OS_PATTERN_3.test(userAgent)) return "ChromeOS";
  if (BROWSER_CLIENT_OS_PATTERN_4.test(userAgent)) return "Windows";
  if (BROWSER_CLIENT_OS_PATTERN_5.test(userAgent)) return "macOS";
  if (BROWSER_CLIENT_OS_PATTERN_6.test(userAgent)) return "Linux";
  return "other";
}

function browserFamily(userAgent: string): string {
  if (userAgent.trim() === "") return "unknown";
  if (BROWSER_FAMILY_PATTERN.test(userAgent)) return "Edge";
  if (BROWSER_FAMILY_PATTERN_2.test(userAgent)) return "Opera";
  if (BROWSER_FAMILY_PATTERN_3.test(userAgent)) return "Samsung Internet";
  if (BROWSER_FAMILY_PATTERN_4.test(userAgent)) return "Firefox";
  if (BROWSER_FAMILY_PATTERN_5.test(userAgent)) return "Chrome";
  if (BROWSER_FAMILY_PATTERN_6.test(userAgent)) return "Safari";
  return "other";
}

function browserDeviceType(identity: BrowserIdentity): AuthClientMetadataDeviceType {
  const userAgent = identity.userAgent;
  if (userAgent.trim() === "") return "unknown";
  if (
    BROWSER_DEVICE_TYPE_PATTERN.test(userAgent) ||
    (BROWSER_CLIENT_OS_PATTERN_2.test(userAgent) &&
      !BROWSER_DEVICE_TYPE_PATTERN_2.test(userAgent)) ||
    isIpadosDesktopUserAgent(identity)
  ) {
    return "tablet";
  }
  if (BROWSER_DEVICE_TYPE_PATTERN_3.test(userAgent)) return "mobile";
  return "desktop";
}

export function clientPresentationMetadata(input: {
  readonly appVersion: string;
  readonly hosted: boolean;
  readonly identity: BrowserIdentity;
  readonly hostBridge: Pick<HostBridge, "getClientPlatform"> | undefined;
}): AuthClientPresentationMetadata {
  if (input.hostBridge !== undefined) {
    return {
      label: "Houston Desktop",
      deviceType: "desktop",
      os: clientOsFromElectronPlatform(input.hostBridge.getClientPlatform()),
      surface: "desktop",
      ...(input.appVersion === "0.0.0" ? {} : { appVersion: input.appVersion }),
    };
  }

  return {
    label: "Houston Web",
    deviceType: browserDeviceType(input.identity),
    os: browserClientOs(input.identity),
    surface: "web",
    webDeployment: input.hosted ? "hosted" : "server",
    browser: browserFamily(input.identity.userAgent),
    ...(input.appVersion === "0.0.0" ? {} : { appVersion: input.appVersion }),
  };
}
