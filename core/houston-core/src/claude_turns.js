// --houston-managed: launch-scoped lifecycle observer, never installed in user settings.
const launcher = __LAUNCHER__;
const sentinel = __SENTINEL__;

async function report($, event, turnId) {
  const pane = await $.env.get('TR_SESSION');
  const channel = await $.env.get('HOUSTON_CHANNEL');
  if (!pane) return;
  const sessionId = await $.session.id();
  const cwd = await $.session.cwd();
  await $.process.run([launcher, 'hook', event, sentinel], {
    env: { TR_SESSION: pane, HOUSTON_CHANNEL: channel || 'release' },
    stdin: JSON.stringify({ session_id: sessionId, cwd, turn_id: turnId }),
    timeoutMs: 1000, // Bound the local helper; a failed report leaves classic hooks intact.
  });
}

export function register(on) {
  let activeTurn;
  let started;
  on('turn.start', async ($, e, next) => {
    activeTurn = e.turnId;
    started = report($, 'ModTurnStart', e.turnId);
    try { await started; } catch { await $.ui.log('Houston: turn lifecycle report failed.'); }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    // Subagents complete inside the pane's turn. Only its main loop can interrupt it.
    if (e.agentId === undefined && e.isAborted === true
        && e.turnId === activeTurn) {
      try {
        try { await started; } catch {
          // An immediate interrupt can cancel the start helper after it writes.
          if (e.turnId !== activeTurn) return next(e);
          await report($, 'ModTurnStart', e.turnId);
        }
        if (e.turnId === activeTurn) {
          await report($, 'ModTurnInterrupted', e.turnId);
          if (e.turnId === activeTurn) activeTurn = undefined;
        }
      } catch { await $.ui.log('Houston: interrupt lifecycle report failed.'); }
    }
    return next(e);
  });
}
