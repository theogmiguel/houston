import type { EnvironmentId } from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { GitBranchIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { Button } from "./button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./dialog";
import { Input } from "./input";
import { toastManager } from "./toast";

function failureMessage(failure: unknown): string {
  const error = squashAtomCommandFailure(failure as never);
  return error instanceof Error ? error.message : "An error occurred.";
}

function notifyError(title: string, failure: unknown) {
  if (isAtomCommandInterrupted(failure as never)) return;
  toastManager.add({ type: "error", title, description: failureMessage(failure) });
}

export function BranchesWorktreesDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
}) {
  const { environmentId, cwd, open } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refs = useEnvironmentQuery(
    open && cwd !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, refKind: "local", limit: 200 },
        })
      : null,
  );
  const worktrees = useEnvironmentQuery(
    open && cwd !== null ? vcsEnvironment.listWorktrees({ environmentId, input: { cwd } }) : null,
  );
  const stashes = useEnvironmentQuery(
    open && cwd !== null ? vcsEnvironment.listStashes({ environmentId, input: { cwd } }) : null,
  );

  const renameRef = useAtomCommand(vcsEnvironment.renameRef, { reportFailure: false });
  const deleteRef = useAtomCommand(vcsEnvironment.deleteRef, { reportFailure: false });
  const pruneWorktrees = useAtomCommand(vcsEnvironment.pruneWorktrees, { reportFailure: false });
  const pushStash = useAtomCommand(vcsEnvironment.pushStash, { reportFailure: false });
  const popStash = useAtomCommand(vcsEnvironment.popStash, { reportFailure: false });
  const dropStash = useAtomCommand(vcsEnvironment.dropStash, { reportFailure: false });

  const localRefs = refs.data?.refs ?? [];
  const refreshAll = () => {
    refs.refresh();
    worktrees.refresh();
    stashes.refresh();
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setBusy(false);
      throw error;
    }
    setBusy(false);
  };

  const submitRename = (oldRefName: string) =>
    run(async () => {
      if (cwd === null) return;
      const newRefName = renameValue.trim();
      if (newRefName.length === 0) return;
      const result = await renameRef({ environmentId, input: { cwd, oldRefName, newRefName } });
      if (result._tag === "Failure") {
        notifyError("Could not rename the branch", result);
        return;
      }
      setRenaming(null);
      setRenameValue("");
      refreshAll();
    });

  const removeBranch = (refName: string) =>
    run(async () => {
      if (cwd === null) return;
      const simple = await deleteRef({
        environmentId,
        input: { cwd, refName, force: false },
      });
      if (simple._tag === "Success") {
        refreshAll();
        return;
      }
      if (isAtomCommandInterrupted(simple)) return;
      const confirmed =
        (await requestConfirmDialog(
          `Branch ${refName} is not merged. Delete it anyway? Commits only on this branch are lost.`,
          { variant: "destructive" },
        )) ?? false;
      if (!confirmed) return;
      const forced = await deleteRef({
        environmentId,
        input: { cwd, refName, force: true },
      });
      if (forced._tag === "Failure") {
        notifyError("Could not delete the branch", forced);
        return;
      }
      refreshAll();
    });

  const prune = () =>
    run(async () => {
      if (cwd === null) return;
      const result = await pruneWorktrees({ environmentId, input: { cwd } });
      if (result._tag === "Failure") {
        notifyError("Could not prune worktrees", result);
        return;
      }
      worktrees.refresh();
    });

  const createStash = () =>
    run(async () => {
      if (cwd === null) return;
      const message = stashMessage.trim();
      const result = await pushStash({
        environmentId,
        input: { cwd, ...(message.length > 0 ? { message } : {}) },
      });
      if (result._tag === "Failure") {
        notifyError("Could not stash changes", result);
        return;
      }
      if (!result.value.created) {
        toastManager.add({ type: "info", title: "Nothing to stash" });
        return;
      }
      setStashMessage("");
      stashes.refresh();
      refs.refresh();
    });

  const restoreStash = (ref: string) =>
    run(async () => {
      if (cwd === null) return;
      const result = await popStash({ environmentId, input: { cwd, ref } });
      if (result._tag === "Failure") {
        notifyError("Could not pop the stash", result);
        return;
      }
      refreshAll();
    });

  const removeStash = (ref: string) =>
    run(async () => {
      if (cwd === null) return;
      const confirmed =
        (await requestConfirmDialog(`Drop ${ref}? The stash cannot be recovered.`, {
          variant: "destructive",
        })) ?? false;
      if (!confirmed) return;
      const result = await dropStash({ environmentId, input: { cwd, ref } });
      if (result._tag === "Failure") {
        notifyError("Could not drop the stash", result);
        return;
      }
      stashes.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Branches and worktrees</DialogTitle>
          <DialogDescription>
            Rename or delete local branches, prune worktrees whose directory is gone, and stash
            local changes.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section className="space-y-2">
            <header className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <GitBranchIcon aria-hidden className="size-4" />
                Branches
              </h3>
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => refs.refresh()}
              >
                <RefreshCwIcon aria-hidden className="size-3" />
                Refresh
              </Button>
            </header>
            <div className="max-h-56 overflow-y-auto rounded-lg bg-card ring-1 ring-foreground/5">
              {localRefs.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No local branches.</p>
              ) : (
                localRefs.map((ref) => (
                  <div
                    key={ref.name}
                    className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{ref.name}</span>
                    {ref.current ? (
                      <span className="shrink-0 text-2xs text-muted-foreground">current</span>
                    ) : null}
                    {renaming === ref.name ? (
                      <>
                        <Input
                          autoFocus
                          size="compact"
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void submitRename(ref.name);
                            if (event.key === "Escape") setRenaming(null);
                          }}
                          aria-label={`New name for ${ref.name}`}
                          className="w-40"
                        />
                        <Button
                          type="button"
                          size="xs"
                          disabled={busy || renameValue.trim().length === 0}
                          onClick={() => void submitRename(ref.name)}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost-muted"
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost-muted"
                          disabled={busy}
                          onClick={() => {
                            setRenaming(ref.name);
                            setRenameValue(ref.name);
                          }}
                        >
                          Rename
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost-destructive"
                          disabled={busy || ref.current}
                          aria-label={`Delete ${ref.name}`}
                          onClick={() => void removeBranch(ref.name)}
                        >
                          <Trash2Icon aria-hidden className="size-3" />
                        </Button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="space-y-2">
            <header className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Worktrees</h3>
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={busy}
                onClick={() => void prune()}
              >
                Prune
              </Button>
            </header>
            <div className="max-h-44 overflow-y-auto rounded-lg bg-card ring-1 ring-foreground/5">
              {(worktrees.data?.worktrees ?? []).map((worktree) => (
                <div
                  key={worktree.path}
                  className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{worktree.path}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {worktree.isBare
                      ? "bare"
                      : worktree.isDetached
                        ? "detached"
                        : (worktree.refName ?? "unknown")}
                  </span>
                  {worktree.prunable !== undefined ? (
                    <span className="shrink-0 text-2xs text-warning">prunable</span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <header className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Stashes</h3>
              <div className="flex items-center gap-2">
                <Input
                  size="compact"
                  value={stashMessage}
                  onChange={(event) => setStashMessage(event.target.value)}
                  placeholder="Stash message (optional)"
                  aria-label="Stash message"
                  className="w-48"
                />
                <Button type="button" size="xs" disabled={busy} onClick={() => void createStash()}>
                  <PlusIcon aria-hidden className="size-3" />
                  Stash changes
                </Button>
              </div>
            </header>
            <div className="max-h-44 overflow-y-auto rounded-lg bg-card ring-1 ring-foreground/5">
              {(stashes.data?.stashes ?? []).length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">No stashes.</p>
              ) : (
                (stashes.data?.stashes ?? []).map((stash) => (
                  <div
                    key={stash.ref}
                    className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs last:border-b-0"
                  >
                    <span className="shrink-0 font-mono text-muted-foreground">{stash.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{stash.message}</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      disabled={busy}
                      onClick={() => void restoreStash(stash.ref)}
                    >
                      Pop
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-destructive"
                      disabled={busy}
                      aria-label={`Drop ${stash.ref}`}
                      onClick={() => void removeStash(stash.ref)}
                    >
                      <Trash2Icon aria-hidden className="size-3" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
