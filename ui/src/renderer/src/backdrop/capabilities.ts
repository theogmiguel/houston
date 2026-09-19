let cached: boolean | null = null

// Detected, never assumed: the app has never used OffscreenCanvas/Worker, and
// WebKitGTK gates both behind runtime settings. Only the main-thread path is
// implemented; this exists so a worker path can land behind it later.
export function supportsOffthreadDither(): boolean {
  if (cached !== null) return cached
  cached = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
  return cached
}
