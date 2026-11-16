import type {
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
  ClientOs,
  HostBridge,
} from "@houston-app/contracts";

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

const MACINTOSH_USER_AGENT = /macintosh/i;
const MAC_USER_AGENT = /mac/i;

function isIpadosDesktopUserAgent(identity: BrowserIdentity): boolean {
  return (
    MACINTOSH_USER_AGENT.test(identity.userAgent) &&
    MAC_USER_AGENT.test(identity.platform) &&
    identity.maxTouchPoints > 1
  );
}

const IOS_USER_AGENT = /iphone|ipad|ipod/i;
const ANDROID_USER_AGENT = /android/i;
const CHROME_OS_USER_AGENT = /cros/i;
const WINDOWS_USER_AGENT = /windows/i;
const MACOS_USER_AGENT = /macintosh|mac os x/i;
const LINUX_USER_AGENT = /linux|x11/i;

function browserClientOs(identity: BrowserIdentity): ClientOs {
  const userAgent = identity.userAgent;
  if (userAgent.trim() === "") return "unknown";
  if (IOS_USER_AGENT.test(userAgent) || isIpadosDesktopUserAgent(identity)) return "iOS";
  if (ANDROID_USER_AGENT.test(userAgent)) return "Android";
  if (CHROME_OS_USER_AGENT.test(userAgent)) return "ChromeOS";
  if (WINDOWS_USER_AGENT.test(userAgent)) return "Windows";
  if (MACOS_USER_AGENT.test(userAgent)) return "macOS";
  if (LINUX_USER_AGENT.test(userAgent)) return "Linux";
  return "other";
}

const EDGE_USER_AGENT = /edg(?:e|a|ios)?\//i;
const OPERA_USER_AGENT = /opr\/|opios\//i;
const SAMSUNG_BROWSER_USER_AGENT = /samsungbrowser\//i;
const FIREFOX_USER_AGENT = /firefox\/|fxios\//i;
const CHROME_USER_AGENT = /chrome\/|crios\//i;
const SAFARI_USER_AGENT = /safari\//i;

function browserFamily(userAgent: string): string {
  if (userAgent.trim() === "") return "unknown";
  if (EDGE_USER_AGENT.test(userAgent)) return "Edge";
  if (OPERA_USER_AGENT.test(userAgent)) return "Opera";
  if (SAMSUNG_BROWSER_USER_AGENT.test(userAgent)) return "Samsung Internet";
  if (FIREFOX_USER_AGENT.test(userAgent)) return "Firefox";
  if (CHROME_USER_AGENT.test(userAgent)) return "Chrome";
  if (SAFARI_USER_AGENT.test(userAgent)) return "Safari";
  return "other";
}

const TABLET_USER_AGENT = /ipad|tablet|kindle|silk/i;
const MOBILE_WORD = /mobile/i;
const PHONE_USER_AGENT = /iphone|ipod|android.+mobile|mobile/i;

function browserDeviceType(identity: BrowserIdentity): AuthClientMetadataDeviceType {
  const userAgent = identity.userAgent;
  if (userAgent.trim() === "") return "unknown";
  if (
    TABLET_USER_AGENT.test(userAgent) ||
    (ANDROID_USER_AGENT.test(userAgent) && !MOBILE_WORD.test(userAgent)) ||
    isIpadosDesktopUserAgent(identity)
  ) {
    return "tablet";
  }
  if (PHONE_USER_AGENT.test(userAgent)) return "mobile";
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
