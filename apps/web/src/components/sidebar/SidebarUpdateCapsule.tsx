import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeUpdateCapsule,
  formatUpdateElapsed,
  RUN_STATUS_LABELS,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
  type UpdateRunLocalState,
  type UpdateRunMachineView,
} from "./updateEverything.logic";
import {
  dismissSettledUpdateRunMachines,
  postponeUpdateRestart,
  retryFailedUpdateRunServers,
} from "./updateEverythingRun";

function useNow(intervalMs: number | null): number {
  const step = intervalMs ?? 60_000;
  const subscribe = (onChange: () => void) => {
    if (intervalMs === null) return () => {};
    const timer = setInterval(onChange, intervalMs);
    return () => clearInterval(timer);
  };
  return useSyncExternalStore(subscribe, () => Math.floor(Date.now() / step) * step);
}

function useUpdateRunMachineViews(run: UpdateEverythingRun): ReadonlyArray<UpdateRunMachineView> {
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(run.machines.map(({ environmentId }) => environmentId)),
    ),
  );
  return run.machines.map((machine, index) => ({
    machine,
    status: resolveUpdateRunMachineStatus(machine, run.phase, updateStates[index]!),
  }));
}

function localStatusLabel(run: UpdateEverythingRun, local: UpdateRunLocalState, now: number) {
  if (run.phase === "countdown" && run.restartAt !== null) {
    return `restarts in ${Math.max(0, Math.ceil((run.restartAt - now) / 1000))}s`;
  }
  if (run.phase === "installing") return "restarting";
  if (local?.status === "downloading") {
    return `downloading${local.percent === null ? "" : ` ${Math.floor(local.percent)}%`}`;
  }
  return "restarts after the servers";
}

export function SidebarUpdateCapsule({
  run,
  local,
  icon,
  onRestart,
}: {
  readonly run: UpdateEverythingRun;
  readonly local: UpdateRunLocalState;
  readonly icon: ReactNode;
  readonly onRestart?: () => Promise<void>;
}) {
  const machines = useUpdateRunMachineViews(run);
  const hasActiveMachine = machines.some(
    ({ status }) => status !== "done" && status !== "failed" && status !== "waiting",
  );
  const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null);
  const view = describeUpdateCapsule(run, machines, local, now);
  const updateServer = useServerUpdate();
  const failed = machines.some(({ status }) => status === "failed");
  const settled = !hasActiveMachine && run.localVersion === null;

  const actionLabel =
    view.action === "later" ? "Later" : view.action === "retry" ? "Retry" : "Dismiss";
  const runAction = () => {
    if (view.action === "later") postponeUpdateRestart();
    else if (view.action === "retry") retryFailedUpdateRunServers(updateServer);
    else dismissSettledUpdateRunMachines();
  };

  return (
    <Popover>
      <div
        className={cn(
          "relative flex h-7 min-w-0 w-full items-center rounded-md text-headline leading-4.5 font-medium",
          view.tone === "failed"
            ? "bg-destructive/12 text-destructive"
            : "bg-(--accent-muted) text-(--update-foreground)",
        )}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={
                view.slow ? `${view.label} ${view.slow.status} ${view.slow.elapsed}` : view.label
              }
              className="absolute inset-0 cursor-pointer rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
            />
          }
        />
        <span className="pointer-events-none relative min-w-0 flex-1 truncate pl-2">
          <span>{view.label}</span>
          {view.slow ? (
            <span className="ml-1 font-normal opacity-80 tabular-nums"> {view.slow.elapsed}</span>
          ) : null}
        </span>
        {view.action !== null ? (
          <button
            type="button"
            className="relative shrink-0 cursor-pointer pr-2 pl-1.5 text-headline underline decoration-current/40 underline-offset-3 hover:decoration-current"
            onClick={runAction}
          >
            {actionLabel}
          </button>
        ) : (
          <span className="pointer-events-none relative grid size-7 shrink-0 place-items-center">
            {icon}
          </span>
        )}
      </div>
      <PopoverPopup side="top" align="end" padding="compact" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          {run.localVersion !== null ? (
            <div className="flex items-center justify-between gap-3">
              <span>This app</span>
              <span className="text-muted-foreground tabular-nums">
                {localStatusLabel(run, local, now)}
              </span>
            </div>
          ) : onRestart ? (
            <div className="flex items-center justify-between gap-3">
              <span>This app</span>
              <Button size="xs" variant="outline" onClick={() => void onRestart()}>
                Restart to update
              </Button>
            </div>
          ) : null}
          {machines.map(({ machine, status }) => (
            <div key={machine.environmentId} className="flex min-w-0 flex-col">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">{machine.label}</span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    status === "failed" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {RUN_STATUS_LABELS[status]}
                  {status !== "done" && status !== "failed" && status !== "waiting"
                    ? ` ${formatUpdateElapsed(now - machine.startedAt)}`
                    : ""}
                </span>
              </div>
              {machine.failure !== null ? (
                <span className="break-words text-muted-foreground">{machine.failure}</span>
              ) : null}
            </div>
          ))}
          {settled && failed ? (
            <div className="mt-1 flex justify-end gap-1">
              {view.action === "retry" ? (
                <Button size="xs" variant="outline" onClick={runAction}>
                  Retry
                </Button>
              ) : null}
              <Button size="xs" variant="ghost" onClick={dismissSettledUpdateRunMachines}>
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

