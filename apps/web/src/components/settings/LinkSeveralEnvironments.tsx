import {
  linkBatchBlockLabel,
  linkBatchCandidates,
  linkBatchFailureLabel,
  type LinkBatchOutcome,
  linkBatchSummary,
  linkListState,
  runLinkBatch,
} from "@houston-app/client-runtime/link-batch";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
} from "@houston-app/contracts";
import * as Result from "effect/Result";
import { useId, useRef, useState } from "react";

import { useT } from "~/i18n/useT";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { LinkAccessPicker } from "./LinkAccessPicker";

const NO_MACHINES: ReadonlySet<EnvironmentId> = new Set();
const NO_OUTCOMES: ReadonlyMap<EnvironmentId, LinkBatchOutcome> = new Map();

/** Links the machines this app reaches in one go. Each pairing code goes from its machine
 * straight to the linking environment, never into state or logs. */
export function LinkSeveralEnvironmentsAction({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const t = useT();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const machines = useLinkableMachines(environmentId, open);
  // The same shared list `useLinkableMachines` reads `linked` from.
  const links = useEnvironmentQuery(
    open ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const linksState = linkListState(links);
  const writable = useEnvironmentsWithScope(machines, AuthAccessWriteScope);
  const [selected, setSelected] = useState(NO_MACHINES);
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [outcomes, setOutcomes] = useState(NO_OUTCOMES);
  const [linking, setLinking] = useState(NO_MACHINES);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const link = useAtomCommand(peerLinkEnvironment.linkInBatch, {
    label: "link several environments",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const candidates = linkBatchCandidates(machines, writable, linksState);
  const selectable = candidates.flatMap(({ machine, blocked }) =>
    blocked === null && outcomes.get(machine.environmentId)?.kind !== "linked" ? [machine] : [],
  );
  const chosen = selectable.filter((machine) => selected.has(machine.environmentId));
  const busy = linking.size > 0;
  const summary = linkBatchSummary(outcomes);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSelected(NO_MACHINES);
      setOutcomes(NO_OUTCOMES);
      setAccess("approval-required");
    }
  };
  const toggle = (id: EnvironmentId, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = async () => {
    if (inFlight.current || chosen.length === 0) return;
    inFlight.current = true;
    setLinking(new Set(chosen.map((machine) => machine.environmentId)));
    const results = await runLinkBatch({
      machines: chosen,
      access,
      mint: mintPairingCodeOn,
      link: async (input) => {
        const result = await link({ environmentId, input });
        return result._tag === "Success"
          ? Result.succeed(result.value)
          : Result.fail(squashAtomCommandFailure(result));
      },
      refreshLinks: links.refresh,
      onOutcome: (id, outcome) => {
        setOutcomes((current) => new Map(current).set(id, outcome));
        setLinking((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      },
    });
    inFlight.current = false;
    setLinking(NO_MACHINES);
    // What failed stays picked, so linking again retries only those.
    setSelected(new Set(linkBatchSummary(results).failed));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            {t("Link several…")}
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Link several environments")}</DialogTitle>
          <DialogDescription>
            {t(
              "Agents here can then launch, message and wait on threads on each machine you pick. Each link appears in that machine's Connections, where it can be revoked.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("This app knows no other machines. Add them under Environments first.")}
              </p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">{t("Machines")}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={busy || selectable.length === 0}
                    onClick={() =>
                      setSelected(
                        chosen.length === selectable.length
                          ? NO_MACHINES
                          : new Set(selectable.map((machine) => machine.environmentId)),
                      )
                    }
                  >
                    {chosen.length === selectable.length && selectable.length > 0
                      ? t("Select none")
                      : t("Select all")}
                  </Button>
                </div>
                {linksState === "loaded" ? null : (
                  <div
                    role="status"
                    className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                  >
                    {linksState === "loading" ? (
                      t("Checking which machines are already linked…")
                    ) : (
                      <>
                        <span className="text-destructive">
                          {t(
                            "Could not check which machines are already linked, so none can be picked: {error}",
                            { error: links.error ?? "" },
                          )}
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={links.isPending}
                          onClick={links.refresh}
                        >
                          {t("Retry")}
                        </Button>
                      </>
                    )}
                  </div>
                )}
                <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                  {candidates.map(({ machine, blocked }) => {
                    const id = machine.environmentId;
                    const outcome = outcomes.get(id);
                    const available = blocked === null && outcome?.kind !== "linked";
                    const status = linking.has(id)
                      ? t("Linking…")
                      : outcome?.kind === "linked"
                        ? t("Linked")
                        : outcome?.kind === "failed"
                          ? t(linkBatchFailureLabel(outcome.failure))
                          : blocked === null
                            ? null
                            : t(linkBatchBlockLabel(blocked));
                    return (
                      <li key={id}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm has-data-disabled:cursor-default">
                          <Checkbox
                            checked={available && selected.has(id)}
                            disabled={busy || !available}
                            onCheckedChange={(checked) => toggle(id, checked)}
                          />
                          <EnvironmentMachineIcon
                            kind={machine.machine}
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{machine.label}</span>
                            {outcome?.kind === "failed" && outcome.detail !== null ? (
                              <span className="block text-xs text-destructive">
                                {outcome.detail}
                              </span>
                            ) : null}
                          </span>
                          {status === null ? null : (
                            <span
                              className={
                                outcome?.kind === "failed"
                                  ? "shrink-0 text-xs text-destructive"
                                  : "shrink-0 text-xs text-muted-foreground"
                              }
                            >
                              {status}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {outcomes.size > 0 && !busy ? (
              <p role="status" className="text-xs text-muted-foreground">
                {summary.failed.length === 0
                  ? summary.linked === 1
                    ? t("Linked 1 machine.")
                    : t("Linked {linked} machines.", { linked: summary.linked })
                  : t(
                      "Linked {linked} of {total}. The ones that failed stay selected, so you can try them again.",
                      { linked: summary.linked, total: outcomes.size },
                    )}
              </p>
            ) : null}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            {outcomes.size > 0 ? t("Done") : t("Cancel")}
          </DialogClose>
          {outcomes.size > 0 && !busy && chosen.length === 0 ? null : (
            <Button form={formId} type="submit" disabled={busy || chosen.length === 0}>
              {busy
                ? t("Linking…")
                : chosen.length === 1
                  ? t("Link 1 machine")
                  : t("Link {count} machines", { count: chosen.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
