import type { EnvironmentId } from "@houston-app/contracts";
import type { InferenceServerSnapshot } from "@houston-app/contracts/houston/inference";
import * as Result from "effect/Result";
import { useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { saveInferenceServer } from "../../state/inference";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Text } from "../ui/text";
import {
  draftFromInferenceServer,
  EMPTY_INFERENCE_SERVER_DRAFT,
  inferenceServerFromDraft,
  type InferenceServerDraft,
} from "./InferenceSettings.logic";

function FieldError({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}) {
  return message === undefined ? null : (
    <Text as="p" id={id} role="alert" variant="caption" tone="danger">
      {message}
    </Text>
  );
}

function failureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message === "" ? "The server could not be saved." : message;
}

/** Mounted per open, so each open starts from a fresh draft. The API key goes to the secret store. */
export function InferenceServerDialog({
  environmentId,
  environmentLabel,
  existing,
  existingIds,
  initialDraft,
  note,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existing?: InferenceServerSnapshot;
  readonly existingIds: ReadonlySet<string>;
  readonly initialDraft?: InferenceServerDraft;
  /** Extra sentence for a prefilled add, such as a server copied from another machine. */
  readonly note?: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const save = useAtomCommand(saveInferenceServer, { reportFailure: false });
  const [draft, setDraft] = useState<InferenceServerDraft>(
    existing ? draftFromInferenceServer(existing) : (initialDraft ?? EMPTY_INFERENCE_SERVER_DRAFT),
  );
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const result = inferenceServerFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id, enabled: existing.enabled } : { mode: "add" },
  );
  const issues = Result.isFailure(result) ? result.failure : {};
  const shown = submitted ? issues : {};

  const update = (patch: Partial<InferenceServerDraft>) => {
    setDraft({ ...draft, ...patch });
    setFailure(null);
  };

  const submit = async () => {
    setSubmitted(true);
    if (Result.isFailure(result) || pending) return;
    setPending(true);
    const outcome = await save({ environmentId, input: result.success });
    setPending(false);
    if (outcome._tag === "Failure") {
      setFailure(failureMessage(outcome.cause));
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {existing ? `Edit ${existing.displayName}` : "Add an inference server"}
          </DialogTitle>
          <DialogDescription>
            An OpenAI-compatible model server that {environmentLabel} can reach. localhost means{" "}
            {environmentLabel} itself.
            {note === undefined ? null : ` ${note}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="inference-server-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-url">Base URL</Label>
              <Input
                id="inference-server-url"
                placeholder="http://localhost:11434/v1"
                value={draft.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
                spellCheck={false}
                aria-invalid={shown.baseUrl !== undefined}
                aria-describedby={
                  shown.baseUrl !== undefined ? "inference-server-url-error" : undefined
                }
                autoFocus
              />
              <FieldError id="inference-server-url-error" message={shown.baseUrl} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-name">Name (optional)</Label>
              <Input
                id="inference-server-name"
                placeholder="Defaults to the host name"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={shown.name !== undefined}
                aria-describedby={
                  shown.name !== undefined ? "inference-server-name-error" : undefined
                }
              />
              <FieldError id="inference-server-name-error" message={shown.name} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-key">API key (optional)</Label>
              <Input
                id="inference-server-key"
                type="password"
                autoComplete="new-password"
                placeholder={
                  existing === undefined
                    ? "Only if the server requires one"
                    : "Leave blank to keep the saved key"
                }
                value={draft.apiKey}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inference-server-concurrency">
                Max concurrent requests (optional)
              </Label>
              <Input
                id="inference-server-concurrency"
                inputMode="numeric"
                placeholder="Server default"
                value={draft.maxConcurrentRequests}
                onChange={(event) => update({ maxConcurrentRequests: event.target.value })}
                aria-invalid={shown.maxConcurrentRequests !== undefined}
                aria-describedby={
                  shown.maxConcurrentRequests !== undefined
                    ? "inference-server-concurrency-error"
                    : undefined
                }
              />
              <FieldError
                id="inference-server-concurrency-error"
                message={shown.maxConcurrentRequests}
              />
            </div>
            {failure === null ? null : (
              <Text as="p" role="alert" variant="caption" tone="danger">
                {failure}
              </Text>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button size="compact" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="compact"
            type="submit"
            form="inference-server-form"
            disabled={pending || (submitted && Result.isFailure(result))}
          >
            {pending ? "Saving…" : existing ? "Save changes" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
