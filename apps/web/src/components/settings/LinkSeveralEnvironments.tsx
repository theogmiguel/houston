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
import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines, useLinkBackOffers } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  LINK_DIALOG_ERROR_CLS,
  LINK_DIALOG_LABEL_CLS,
  LINK_DIALOG_LEAD_CLS,
  LINK_DIALOG_LIST_CLS,
  LINK_DIALOG_NAME_CLS,
  LINK_HINT_CLS,
  LINK_OPTION_CLS,
  MAP_ERROR_CLS,
  MAP_MUTED_CLS,
  STRONG_LABEL_CLS,
} from "../ui/environments-map-recipes";
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
} from "../ui/dialog";
import { LinkAccessPicker } from "./LinkAccessPicker";

const NO_MACHINES: ReadonlySet<EnvironmentId> = new Set();
const NO_OUTCOMES: ReadonlyMap<EnvironmentId, LinkBatchOutcome> = new Map();

export function LinkSeveralEnvironmentsAction({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        {t("Link several…")}
      </Button>
      <LinkSeveralEnvironmentsDialog
        environmentId={environmentId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * Links the machines this app reaches in one go. Each pairing code goes from its machine
 * straight to the linking environment, never into state or logs.
 */
export function LinkSeveralEnvironmentsDialog({
  environmentId,
  open,
  onOpenChange,
  preset,
  presetOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Machines picked before the dialog opened. Those a batch cannot link stay unticked. */
  readonly preset?: ReadonlyArray<EnvironmentId>;
  /** Lists only the `preset` machines: they were picked for this link, not as a suggestion. */
  readonly presetOnly?: boolean;
}) {
  const t = useT();
  const formId = useId();
  const sourceLabel = useEnvironments().environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.label;
  const known = useLinkableMachines(environmentId, open);
  const machines =
    presetOnly && preset !== undefined
      ? known.filter((machine) => preset.includes(machine.environmentId))
      : known;
  // The same shared list `useLinkableMachines` reads `linked` from.
  const links = useEnvironmentQuery(
    open ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const linksState = linkListState(links);
  const writable = useEnvironmentsWithScope(machines, AuthAccessWriteScope);
  const [selected, setSelected] = useState<ReadonlySet<EnvironmentId>>(() => new Set(preset));
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [outcomes, setOutcomes] = useState(NO_OUTCOMES);
  const [linking, setLinking] = useState(NO_MACHINES);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  // The failure cause holds the request, and with it the code; keep it out of the console.
  const quiet = { reportFailure: false, reportDefect: false };
  const link = useAtomCommand(peerLinkEnvironment.linkInBatch, {
    label: "link several environments",
    ...quiet,
  });
  // Each machine links back once, so each refreshes its own list.
  const linkOn = useAtomCommand(peerLinkEnvironment.link, {
    label: "link environment back",
    ...quiet,
  });
  const [alsoLinkBack, setAlsoLinkBack] = useState(false);
  const candidates = linkBatchCandidates(machines, writable, linksState);
  const selectable = candidates.flatMap(({ machine, blocked }) =>
    blocked === null && outcomes.get(machine.environmentId)?.kind !== "linked" ? [machine] : [],
  );
  const chosen = selectable.filter((machine) => selected.has(machine.environmentId));
  const linkBack = useLinkBackOffers(
    environmentId,
    selectable.map((machine) => machine.environmentId),
    open,
  );
  const canLinkBack = (machine: { readonly environmentId: EnvironmentId }) =>
    linkBack.offerFor(machine.environmentId).kind === "offered";
  const backOffered = linkBack.source !== null && selectable.some(canLinkBack);
  const oneWayOnly = chosen.filter((machine) => !canLinkBack(machine)).length;
  const busy = linking.size > 0;
  const summary = linkBatchSummary(outcomes);
  const backFailed = [...outcomes.values()].filter(
    (outcome) => outcome.kind === "linked" && outcome.back?.kind === "failed",
  ).length;
  // Picked on the map, but only another machine's link names them: this app has no session there.
  const unlisted = (preset ?? []).filter(
    (id) => !candidates.some(({ machine }) => machine.environmentId === id),
  ).length;

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setSelected(NO_MACHINES);
      setOutcomes(NO_OUTCOMES);
      setAccess("approval-required");
      setAlsoLinkBack(false);
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
      ...(alsoLinkBack && linkBack.source !== null
        ? {
            back: {
              source: linkBack.source,
              targets: new Set(chosen.filter(canLinkBack).map((machine) => machine.environmentId)),
              link: async (targetId, input) => {
                const result = await linkOn({ environmentId: targetId, input });
                return result._tag === "Success"
                  ? Result.succeed(result.value)
                  : Result.fail(squashAtomCommandFailure(result));
              },
            },
          }
        : {}),
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
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {sourceLabel === undefined
              ? t("Link several environments")
              : t("Link several machines from {source}", { source: sourceLabel })}
          </DialogTitle>
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
              <p className={LINK_DIALOG_LEAD_CLS}>
                {presetOnly
                  ? t("This app is not connected to any of the machines you picked.")
                  : t("This app knows no other machines. Add them under Environments first.")}
              </p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={LINK_DIALOG_LABEL_CLS}>{t("Machines")}</span>
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
                    className={cn("flex items-center justify-between gap-2", LINK_HINT_CLS)}
                  >
                    {linksState === "loading" ? (
                      t("Checking which machines are already linked…")
                    ) : (
                      <>
                        <span className={MAP_ERROR_CLS}>
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
                <ul className={cn("max-h-72 overflow-y-auto", LINK_DIALOG_LIST_CLS)}>
                  {candidates.map(({ machine, blocked }) => {
                    const id = machine.environmentId;
                    const outcome = outcomes.get(id);
                    const available = blocked === null && outcome?.kind !== "linked";
                    const back = outcome?.kind === "linked" ? outcome.back : undefined;
                    const status = linking.has(id)
                      ? t("Linking…")
                      : outcome?.kind === "linked"
                        ? back?.kind === "linked"
                          ? t("Linked both ways")
                          : back?.kind === "failed"
                            ? t("Linked one way")
                            : t("Linked")
                        : outcome?.kind === "failed"
                          ? t(linkBatchFailureLabel(outcome.failure))
                          : blocked === null
                            ? null
                            : t(linkBatchBlockLabel(blocked));
                    const failed = outcome?.kind === "failed" || back?.kind === "failed";
                    return (
                      <li key={id}>
                        <label
                          className={cn("flex items-center gap-2.5 px-3 py-2", LINK_OPTION_CLS)}
                        >
                          <Checkbox
                            checked={available && selected.has(id)}
                            disabled={busy || !available}
                            onCheckedChange={(checked) => toggle(id, checked)}
                          />
                          <EnvironmentMachineIcon
                            kind={machine.machine}
                            className={cn("size-4 shrink-0", MAP_MUTED_CLS)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className={cn("block truncate", LINK_DIALOG_NAME_CLS)}>
                              {machine.label}
                            </span>
                            {outcome?.kind === "failed" && outcome.detail !== null ? (
                              <span className={cn("block", LINK_DIALOG_ERROR_CLS)}>
                                {outcome.detail}
                              </span>
                            ) : null}
                            {back?.kind === "failed" ? (
                              <span className={cn("block", LINK_DIALOG_ERROR_CLS)}>
                                {t("Could not link back: {reason}", {
                                  reason: back.detail ?? t(linkBatchFailureLabel(back.failure)),
                                })}
                              </span>
                            ) : null}
                          </span>
                          {status === null ? null : (
                            <span
                              className={cn(
                                "shrink-0",
                                failed ? LINK_DIALOG_ERROR_CLS : LINK_HINT_CLS,
                              )}
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
            {unlisted > 0 ? (
              <p className={LINK_HINT_CLS}>
                {unlisted === 1
                  ? t("1 machine needs a pairing code, so it is not listed.")
                  : t("{count} machines need a pairing code, so they are not listed.", {
                      count: unlisted,
                    })}
              </p>
            ) : null}
            {outcomes.size > 0 && !busy ? (
              <p role="status" className={LINK_HINT_CLS}>
                {summary.failed.length === 0
                  ? summary.linked === 1
                    ? t("Linked 1 machine.")
                    : t("Linked {linked} machines.", { linked: summary.linked })
                  : t(
                      "Linked {linked} of {total}. The ones that failed stay selected, so you can try them again.",
                      { linked: summary.linked, total: outcomes.size },
                    )}
                {backFailed > 0
                  ? ` ${
                      backFailed === 1
                        ? t("1 machine could not link back.")
                        : t("{count} machines could not link back.", { count: backFailed })
                    }`
                  : null}
              </p>
            ) : null}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
            {backOffered && sourceLabel !== undefined ? (
              <label className={cn("flex items-start gap-2.5", LINK_OPTION_CLS)}>
                <Checkbox
                  checked={alsoLinkBack}
                  disabled={busy}
                  onCheckedChange={setAlsoLinkBack}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className={cn("block", STRONG_LABEL_CLS)}>
                    {t("Also link each machine back to {source}", { source: sourceLabel })}
                  </span>
                  <span className={cn("block", LINK_HINT_CLS)}>
                    {t("Agents there can then work on {source} too.", { source: sourceLabel })}
                    {alsoLinkBack && oneWayOnly > 0
                      ? ` ${
                          oneWayOnly === 1
                            ? t("1 machine stays one-way.")
                            : t("{count} machines stay one-way.", { count: oneWayOnly })
                        }`
                      : null}
                  </span>
                </span>
              </label>
            ) : null}
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
