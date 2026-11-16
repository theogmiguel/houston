const SUPPORTED_PLATFORMS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "linux-x64",
  "linux-arm64",
]);

export function isSpeechPlatformSupported(
  platform: string,
  architecture: string,
  libc: "gnu" | "musl" | undefined,
): boolean {
  return (
    (platform !== "linux" || libc === "gnu") &&
    SUPPORTED_PLATFORMS.has(`${platform}-${architecture}`)
  );
}

/** Why native speech cannot run here, naming what was found and what is needed; null when it can. */
export function speechPlatformRefusal(
  platform: string,
  architecture: string,
  libc: "gnu" | "musl" | undefined,
): string | null {
  if (isSpeechPlatformSupported(platform, architecture, libc)) return null;
  const found = `${platform}-${architecture}${platform === "linux" && libc ? ` with ${libc === "gnu" ? "glibc" : "musl libc"}` : ""}`;
  return `voice transcription is not available on ${found}; it needs one of ${[...SUPPORTED_PLATFORMS].join(", ")}${platform === "linux" ? " with glibc" : ""}`;
}
