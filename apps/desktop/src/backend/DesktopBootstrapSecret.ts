// @effect-diagnostics nodeBuiltinImport:off -- the keychain secret needs a hash and random bytes before Electron is ready.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export const KEYCHAIN_SERVICE_PREFIX = "houston-v2";
export const KEYCHAIN_PROFILE = "desktop-bootstrap-secret";
// Match the server-side check: anything shorter cannot carry the rotating token.
const MIN_SECRET_LENGTH = 32;

export interface DesktopKeychainEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
}

export interface DesktopKeychain {
  entry(service: string, account: string): DesktopKeychainEntry;
}

export type BootstrapSecretKeychainEntry = DesktopKeychainEntry;
export type BootstrapSecretKeychain = DesktopKeychain;

export interface DesktopBootstrapSecretValue {
  readonly secret: string;
  readonly warning: Option.Option<string>;
}

/** `<prefix>-<first 16 hex of sha256(trimmed base dir)>`: one service per state directory. */
export function keychainServiceName(prefix: string, baseDir: string): string {
  const digest = NodeCrypto.createHash("sha256").update(baseDir.trim()).digest("hex");
  return `${prefix}-${digest.slice(0, 16)}`;
}

export function bootstrapSecretServiceName(baseDir: string): string {
  return keychainServiceName(KEYCHAIN_SERVICE_PREFIX, baseDir);
}

export function isMissingKeychainEntry(error: unknown): boolean {
  return /no (matching )?entry|not found/i.test(keychainErrorMessage(error));
}

export function newBootstrapSecret(): string {
  // Two v4 UUIDs: 256 bits of randomness without another dependency.
  return `${NodeCrypto.randomUUID().replaceAll("-", "")}${NodeCrypto.randomUUID().replaceAll("-", "")}`;
}

const keychainUnavailableWarning = (
  reason: string,
  fallback: string,
): DesktopBootstrapSecretValue => ({
  secret: fallback,
  warning: Option.some(
    `The system keychain is unavailable (${reason}); Houston generated a temporary desktop secret for this run. Agents stop authenticating after Houston restarts. Install and unlock a Secret Service provider such as gnome-keyring or KWallet.`,
  ),
});

/** Loads the per-base-directory secret, replacing a malformed entry or creating one. */
export async function loadOrCreateDesktopBootstrapSecret(input: {
  readonly baseDir: string;
  readonly keychain: BootstrapSecretKeychain | null;
  readonly fallbackSecret: string;
  readonly unavailableReason?: string;
}): Promise<DesktopBootstrapSecretValue> {
  const { baseDir, keychain, fallbackSecret } = input;
  if (keychain === null) {
    return keychainUnavailableWarning(
      input.unavailableReason ?? "no keychain provider is available",
      fallbackSecret,
    );
  }

  const entry = keychain.entry(bootstrapSecretServiceName(baseDir), KEYCHAIN_PROFILE);
  let existing: string | null | undefined;
  try {
    existing = await entry.getPassword();
  } catch (error) {
    if (!isMissingKeychainEntry(error)) {
      return keychainUnavailableWarning(keychainErrorMessage(error), fallbackSecret);
    }
  }

  if (typeof existing === "string" && existing.length >= MIN_SECRET_LENGTH) {
    return { secret: existing, warning: Option.none() };
  }

  // Missing and malformed entries both start from a fresh secret.
  const secret = newBootstrapSecret();
  try {
    await entry.setPassword(secret);
    return { secret, warning: Option.none() };
  } catch (error) {
    return keychainUnavailableWarning(keychainErrorMessage(error), fallbackSecret);
  }
}

export function keychainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadDesktopKeychain(): Promise<{
  readonly keychain: BootstrapSecretKeychain | null;
  readonly unavailableReason?: string;
}> {
  try {
    const Keyring = await import("@napi-rs/keyring");
    return {
      keychain: {
        entry: (service, account) => new Keyring.AsyncEntry(service, account),
      },
    };
  } catch (error) {
    return { keychain: null, unavailableReason: keychainErrorMessage(error) };
  }
}

export class DesktopBootstrapSecret extends Context.Service<
  DesktopBootstrapSecret,
  {
    readonly resolve: Effect.Effect<DesktopBootstrapSecretValue>;
  }
>()("@houston-app/desktop/backend/DesktopBootstrapSecret") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const cached = yield* Ref.make<Option.Option<DesktopBootstrapSecretValue>>(Option.none());
  const mutex = yield* Semaphore.make(1);
  const fallbackSecret = newBootstrapSecret();

  const resolve = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(cached);
        if (Option.isSome(current)) {
          return current.value;
        }
        const loaded = yield* Effect.promise(loadDesktopKeychain);
        const value = yield* Effect.promise(() =>
          loadOrCreateDesktopBootstrapSecret({
            baseDir: environment.baseDir,
            keychain: loaded.keychain,
            fallbackSecret,
            ...(loaded.unavailableReason === undefined
              ? {}
              : { unavailableReason: loaded.unavailableReason }),
          }),
        );
        yield* Ref.set(cached, Option.some(value));
        return value;
      }),
    )
    .pipe(Effect.withSpan("desktop.bootstrapSecret.resolve"));

  return DesktopBootstrapSecret.of({ resolve });
});

export const layer = Layer.effect(DesktopBootstrapSecret, make);
