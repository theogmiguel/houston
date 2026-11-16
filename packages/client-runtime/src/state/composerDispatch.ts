export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export interface FollowUpDispatch {
  readonly mode: ComposerDispatchMode;
  /** The user asked to steer, but this provider cannot redirect an active run. */
  readonly queuedBecauseProviderCannotSteer: boolean;
}

/**
 * A follow-up send whose steer intent falls back to the queue when the provider cannot
 * redirect an active run, so the message is delivered instead of refused.
 */
export function resolveFollowUpDispatch(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  readonly canSteer?: boolean;
  readonly providerSupportsActiveSteering: boolean;
}): FollowUpDispatch {
  const canSteer = input.canSteer !== false && input.providerSupportsActiveSteering;
  const mode = resolveComposerDispatchMode({
    running: input.running,
    alternateModifier: input.alternateModifier,
    ...(input.activeTurnDefault === undefined
      ? {}
      : { activeTurnDefault: input.activeTurnDefault }),
    canSteer,
  });
  const requestedMode = resolveComposerDispatchMode({
    running: input.running,
    alternateModifier: input.alternateModifier,
    ...(input.activeTurnDefault === undefined
      ? {}
      : { activeTurnDefault: input.activeTurnDefault }),
    ...(input.canSteer === undefined ? {} : { canSteer: input.canSteer }),
  });
  return {
    mode,
    queuedBecauseProviderCannotSteer:
      input.running &&
      input.canSteer !== false &&
      !input.providerSupportsActiveSteering &&
      mode === "queue" &&
      requestedMode === "steer",
  };
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
