import type { DevicePlatform } from "@houston-app/contracts";

const RESOLVE_DEVICE_MODEL_ID_PATTERN = /^iPhone Duo$/i;
const RESOLVE_DEVICE_MODEL_ID_PATTERN_2 = /^iPhone 18 Pro Max$/i;
const RESOLVE_DEVICE_MODEL_ID_PATTERN_3 = /^iPhone 18 Pro$/i;
const RESOLVE_DEVICE_MODEL_ID_PATTERN_4 = /^iPad Pro 13-inch \(M5\)$/i;

export type DeviceModelId = "iphone-18-pro" | "iphone-18-pro-max" | "ipad-pro-13-m5" | "iphone-duo";

export interface DeviceModelSource {
  readonly id: DeviceModelId;
  readonly url: string;
}

export interface DeviceAccessorySource {
  readonly id: "ipad-pro-13-m5-magic-keyboard";
  readonly modelId: "ipad-pro-13-m5";
  readonly url: string;
}

export type DeviceAssetSource = DeviceModelSource | DeviceAccessorySource;

export function resolveDeviceModelId(platform: DevicePlatform, name: string): DeviceModelId | null {
  if (platform !== "ios") return null;
  if (RESOLVE_DEVICE_MODEL_ID_PATTERN.test(name)) return "iphone-duo";
  if (RESOLVE_DEVICE_MODEL_ID_PATTERN_2.test(name)) return "iphone-18-pro-max";
  if (RESOLVE_DEVICE_MODEL_ID_PATTERN_3.test(name)) return "iphone-18-pro";
  if (RESOLVE_DEVICE_MODEL_ID_PATTERN_4.test(name)) return "ipad-pro-13-m5";
  return null;
}

/** Each request owns its result. A cancelled or superseded parse must still release its resources. */
export function createDeviceModelSlot<
  T extends { dispose: () => void },
  Source extends DeviceAssetSource = DeviceModelSource,
>(options: {
  load: (source: Source, signal: AbortSignal) => Promise<T>;
  install: (model: T | null) => void;
  onError?: ((cause: unknown) => void) | undefined;
}) {
  let request: { source: Source; controller: AbortController } | null = null;
  let current: T | null = null;
  let disposed = false;
  const clear = () => {
    if (current) options.install(null);
    current?.dispose();
    current = null;
  };
  return {
    set(source: Source | null) {
      if (disposed) return;
      if (source?.id === request?.source.id && source?.url === request?.source.url) return;
      request?.controller.abort();
      request = null;
      clear();
      if (!source) return;
      const next = { source, controller: new AbortController() };
      request = next;
      void options.load(source, next.controller.signal).then(
        (model) => {
          if (disposed || request !== next) {
            model.dispose();
            return;
          }
          try {
            options.install(model);
            current = model;
          } catch (cause) {
            options.install(null);
            model.dispose();
            request = null;
            options.onError?.(cause);
          }
        },
        (cause: unknown) => {
          if (!disposed && request === next) {
            request = null;
            options.onError?.(cause);
          }
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      request?.controller.abort();
      request = null;
      clear();
    },
  };
}
