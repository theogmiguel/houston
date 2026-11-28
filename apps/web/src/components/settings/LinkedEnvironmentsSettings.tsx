import { useAtomValue } from "@effect/atom-react";
import {
  linkBackBlockLabel,
  linkBatchFailureLabel,
  linkWithMintedCode,
} from "@houston-app/client-runtime/link-batch";
import { linkRequestFailureMessage } from "@houston-app/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkSummary,
} from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { peerLinkHealth, type PeerLinkHealth } from "@houston-app/client-runtime/state/peerLinks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironment, useEnvironments } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines, useLinkBackOffers } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { LINK_HINT_CLS, LINK_OPTION_CLS, STRONG_LABEL_CLS } from "../ui/environments-map-recipes";
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
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { ANOTHER_ADDRESS, LinkMachineSelect } from "./LinkMachineSelect";
import { LinkSeveralEnvironmentsAction } from "./LinkSeveralEnvironments";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useNowMinute } from "../../hooks/useNowMinute";
import { searchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const links = useEnvironmentQuery(peerLinkEnvironment.list({ environmentId, input: {} }));
  const refreshLinks = links.refresh;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- re-asks the server: the composer keeps this query mounted, so a link made from the CLI or another client is listed only after a refetch
  useEffect(() => refreshLinks(), [refreshLinks]);
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const search = searchableSetting("linked-environments");
  // A batch needs at least two other machines this app has saved.
  const otherMachines = useEnvironments().environments.length - 1;
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={
        canLink ? (
          <div className="flex items-center gap-2">
            {otherMachines > 1 ? (
              <LinkSeveralEnvironmentsAction environmentId={environmentId} />
            ) : null}
            <LinkEnvironmentAction environmentId={environmentId} />
          </div>
        ) : null
      }
    >
      {links.error ? (
        <SettingsRow title="Could not load linked environments" description={links.error} />
      ) : !links.data ? (
        <SettingsRow title="Loading linked environments…" role="status" />
      ) : links.data.links.length === 0 ? (
        <SettingsRow
          title="No linked environments"
          description="Link another machine running Houston, such as a VPS, so agents here can launch and drive threads there."
        />
      ) : (
        links.data.links.map((link) => (
          <LinkedEnvironmentRow
            key={link.environmentId}
            environmentId={environmentId}
            link={link}
          />
        ))
      )}
    </SettingsSection>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const { busy, forget } = useForgetPeerLink(environmentId, link);
  const status = peerLinkStatusText(health);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {accessConfig[link.access].label} · {status}
          </p>
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
        </div>
        {canUnlink ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy ? "Forgetting…" : "Forget"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkEnvironmentAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  return (
    <LinkEnvironmentDialog
      environmentId={environmentId}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Link
            </Button>
          }
        />
      }
    />
  );
}

/** What the link dialog opens with when something other than its own button opened it. */
export interface LinkEnvironmentPrefill {
  /** The machine to link to, by environment id, or `ANOTHER_ADDRESS` with `address`. */
  readonly choice: string | null;
  readonly address?: string;
}

/**
 * The one link flow. When this client is connected to the picked machine and may create pairing
 * links there, it mints the code itself; otherwise it asks for one.
 */
export function LinkEnvironmentDialog({
  environmentId,
  open,
  onOpenChange,
  trigger = null,
  prefill,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactNode;
  readonly prefill?: LinkEnvironmentPrefill;
}) {
  const setOpen = onOpenChange;
  // Named in the title: from the map, nothing else on screen says which machine is linking.
  const source = useEnvironment(environmentId);
  const machines = useLinkableMachines(environmentId, open);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(prefill?.choice ?? null);
  const [address, setAddress] = useState(prefill?.address ?? "");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  const linkOnTarget = useAtomCommand(peerLinkEnvironment.link, {
    label: "link environment back",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [alsoLinkBack, setAlsoLinkBack] = useState(false);
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  // This client can mint a code there when it is connected to that
  // environment with a session that may create pairing links.
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  const canMint =
    targetId !== null && Option.isSome(connected) && mayMint && !mintFailed.has(targetId);
  const linkBack = useLinkBackOffers(environmentId, targetId === null ? [] : [targetId], open);
  const backOffer = linkBack.offerFor(targetId);
  const needsAddress = selected === ANOTHER_ADDRESS || machine?.urls.length === 0;
  const ready =
    selected !== null &&
    (!needsAddress || address.trim().length > 0) &&
    (canMint || pairingCode.trim().length > 0);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(prefill?.choice ?? null);
      setAddress(prefill?.address ?? "");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
      setAlsoLinkBack(false);
    }
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, access);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast("Could not link the environment", linkRequestFailureMessage(minted.failure));
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const code = await resolvePairingCode();
    const result =
      code === null
        ? null
        : await link({
            environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              ...(machine === null
                ? {}
                : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
              pairingCode: code,
              access,
            },
          });
    // The link back is its own link, made on the other machine: it never undoes this one.
    const back =
      result?._tag === "Success" &&
      alsoLinkBack &&
      backOffer.kind === "offered" &&
      linkBack.source !== null &&
      targetId !== null &&
      // A typed address can answer as another machine: the picked one links back only if it did.
      result.value.environmentId === targetId
        ? await linkWithMintedCode({
            machine: linkBack.source,
            access,
            mint: mintPairingCodeOn,
            link: async (input) => {
              const reverse = await linkOnTarget({ environmentId: targetId, input });
              return reverse._tag === "Success"
                ? Result.succeed(reverse.value)
                : Result.fail(squashAtomCommandFailure(reverse));
            },
          })
        : null;
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      const sourceLabel = source?.label ?? "";
      toastManager.add({
        type: "success",
        title:
          back?.kind === "linked"
            ? `Linked ${sourceLabel} and ${result.value.label} both ways`
            : `Linked ${result.value.label}`,
      });
      if (back?.kind === "failed") {
        failureToast(
          `Could not link ${result.value.label} back to ${sourceLabel}`,
          back.detail ?? linkBatchFailureLabel(back.failure),
        );
      }
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not link the environment", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      {trigger}
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {source === null
              ? "Link an environment"
              : machine === null
                ? `Link ${source.label} to another machine`
                : `Link ${source.label} to ${machine.label}`}
          </DialogTitle>
          <DialogDescription>
            Agents here can then launch, message and wait on threads there. It appears in that
            environment's Connections, where it can be revoked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={(next) => {
                  // The opt-in names one machine: it does not carry over to another.
                  if (next !== selected) setAlsoLinkBack(false);
                  setChoice(next);
                }}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                Already linked. Linking again renews it with the access you pick.
              </p>
            ) : null}
            {needsAddress ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Address</span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    This app has no address for {machine.label} that another machine can reach.
                    Enter its https or Tailscale address.
                  </span>
                ) : null}
              </label>
            ) : null}
            {selected === null || canMint ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Pairing code</span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? "From that environment's Connections, or houston pair there"
                      : "Paste the code"
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    Create a link on {machine.label}: Settings → Connections → Create link, then
                    paste its code here.
                  </span>
                ) : null}
              </label>
            )}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
            {machine === null || source === null ? null : backOffer.kind === "offered" ? (
              <label className={cn("flex items-start gap-2.5", LINK_OPTION_CLS)}>
                <Checkbox
                  checked={alsoLinkBack}
                  disabled={busy}
                  onCheckedChange={setAlsoLinkBack}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className={cn("block", STRONG_LABEL_CLS)}>
                    Also link {machine.label} back to {source.label}
                  </span>
                  <span className={cn("block", LINK_HINT_CLS)}>
                    Agents on {machine.label} can then work on {source.label} too.
                  </span>
                </span>
              </label>
            ) : backOffer.kind === "blocked" ? (
              <p className={LINK_HINT_CLS}>
                {linkBackBlockLabel(backOffer.reason, {
                  source: source.label,
                  target: machine.label,
                })}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** What a link's health means for the user, in a sentence. */
export function peerLinkStatusText(health: PeerLinkHealth): string {
  return health.kind === "expired"
    ? "Expired. Link it again with a new pairing code."
    : health.kind === "unreachable"
      ? (health.detail ?? "Not answering right now.")
      : health.kind === "failing"
        ? health.detail
        : health.expiresInDays !== null
          ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}. Link it again to renew.`
          : "Reachable";
}

/** Forgets `link` from `environmentId` after the user confirms. */
export function useForgetPeerLink(environmentId: EnvironmentId, link: PeerLinkSummary) {
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Forget ${link.label}? Agents here stop working there. Revoke "Houston · …" in ${link.label}'s Connections to end the session there too.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not forget the link", String(squashAtomCommandFailure(result)));
    }
  };
  return { busy, forget };
}
