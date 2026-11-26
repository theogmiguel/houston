import type { HoustonMcpSignInErrorKind, OrchestrationV2TurnItem } from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { readLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { completeMcpSignIn, startMcpSignIn } from "../../state/mcpSignIn";
import { useT } from "~/i18n/useT";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Glyph } from "../ui/glyph";
import { Input } from "../ui/input";
import { MOTION_DISCLOSURE_REVEAL } from "../ui/motion-recipes";
import { Spinner } from "../ui/spinner";
import { Swap } from "../ui/swap";
import { Text } from "../ui/text";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { WorkLogRow } from "./WorkLog";
import type { TimestampFormat } from "@houston-app/contracts/settings";
import type { EnvironmentId } from "@houston-app/contracts";

type SignInFailure = {
  readonly kind: HoustonMcpSignInErrorKind | "failed";
  readonly message: string;
};

type Phase = "idle" | "awaiting" | "completing";

function signInFailure(cause: unknown): SignInFailure {
  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { _tag?: unknown })._tag === "HoustonMcpSignInError"
  ) {
    const failure = cause as { kind: HoustonMcpSignInErrorKind; message: string };
    return { kind: failure.kind, message: failure.message };
  }
  return { kind: "failed", message: "MCP sign-in failed. Try again." };
}

/** A sign-in time only covers the notices raised before it; a newer notice asks again. */
export function mcpSignInCoversNotice(
  signedInAt: string | undefined,
  noticeCreatedAt: string,
): boolean {
  if (signedInAt === undefined) return false;
  const signedAt = Date.parse(signedInAt);
  const noticeAt = Date.parse(noticeCreatedAt);
  return Number.isFinite(signedAt) && Number.isFinite(noticeAt) && signedAt >= noticeAt;
}

function openAuthorizationPage(url: string): Promise<unknown> {
  const api = readLocalApi();
  if (api === undefined) {
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve(true);
  }
  return api.shell.openExternal(url);
}

export function McpSignInNotice({
  item,
  server,
  environmentId,
  createdAt,
  timestampFormat,
  signedInAt,
  onSignedIn,
}: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "system_notice" }>;
  readonly server: string;
  readonly environmentId: EnvironmentId;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly signedInAt: string | undefined;
  readonly onSignedIn: (server: string, signedInAt: string) => void;
}) {
  const t = useT();
  const providerThreadId = item.providerThreadId;
  const [phase, setPhase] = useState<Phase>("idle");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<SignInFailure | null>(null);
  const start = useAtomCommand(startMcpSignIn, {
    label: "start MCP sign-in",
    reportFailure: false,
    reportDefect: false,
  });
  const complete = useAtomCommand(completeMcpSignIn, {
    label: "complete MCP sign-in",
    reportFailure: false,
    reportDefect: false,
  });

  const signedIn = mcpSignInCoversNotice(signedInAt, createdAt);
  const terminal = error?.kind === "session-ended" || error?.kind === "unsupported-provider";
  const rejected = error?.kind === "callback-rejected";
  const fieldError = rejected
    ? t("Expected the http://127.0.0.1 address the sign-in ended on.")
    : null;
  const noticeError = terminal
    ? error?.kind === "session-ended"
      ? t("This session ended, so sign-in can't start.")
      : error?.message
    : error !== null && !rejected
      ? error.message
      : null;

  const markSignedIn = (at: string) => {
    setPhase("idle");
    setCallbackUrl("");
    setError(null);
    onSignedIn(server, at);
  };

  const begin = async () => {
    if (providerThreadId === null || starting) return;
    setStarting(true);
    setError(null);
    const result = await start({
      environmentId,
      input: { threadId: item.threadId, providerThreadId, server },
    });
    setStarting(false);
    if (result._tag === "Success") {
      if (result.value.authorizationUrl === null) {
        if (result.value.signedInAt !== null) markSignedIn(result.value.signedInAt);
        return;
      }
      try {
        await openAuthorizationPage(result.value.authorizationUrl);
      } catch {
        setError({ kind: "failed", message: t("Could not open the sign-in page. Try again.") });
        return;
      }
      setPhase("awaiting");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = signInFailure(squashAtomCommandFailure(result));
      setError(failure);
      if (failure.kind === "session-ended" || failure.kind === "unsupported-provider") {
        setPhase("idle");
      }
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const pasted = callbackUrl.trim();
    if (providerThreadId === null || pasted.length === 0 || phase === "completing") return;
    setPhase("completing");
    setError(null);
    const result = await complete({
      environmentId,
      input: { threadId: item.threadId, providerThreadId, server, callbackUrl: pasted },
    });
    if (result._tag === "Success") {
      markSignedIn(result.value.signedInAt);
      return;
    }
    setPhase("awaiting");
    if (!isAtomCommandInterrupted(result)) {
      const failure = signInFailure(squashAtomCommandFailure(result));
      setError(failure);
      if (failure.kind === "session-ended" || failure.kind === "unsupported-provider") {
        setPhase("idle");
      }
    }
  };

  const labelText = signedIn ? `${server} signed in` : item.message;
  const swapKey = signedIn
    ? "signed-in"
    : terminal && error !== null
      ? `terminal-${error.kind}`
      : "needs-sign-in";
  const showSignIn = !signedIn && !terminal && phase === "idle" && providerThreadId !== null;
  const showForm = !signedIn && !terminal && phase !== "idle";
  const continueDisabled =
    phase === "completing" || callbackUrl.trim().length === 0 || providerThreadId === null;

  return (
    <WorkLogRow
      data-v2-item-type="system_notice"
      icon={
        signedIn ? (
          <Glyph icon={CheckIcon} tone="success" />
        ) : (
          <Glyph icon={CircleAlertIcon} tone="warning" />
        )
      }
      meta={<TimelineRowTimestamp createdAt={createdAt} timestampFormat={timestampFormat} />}
      trailing={
        showSignIn ? (
          <Button type="button" size="xs" disabled={starting} onClick={() => void begin()}>
            {starting ? <Spinner size="xs" /> : null}
            {t("Sign in")}
          </Button>
        ) : null
      }
      wrapLabel
      label={
        <div className="flex min-w-0 flex-col gap-1">
          <Swap swapKey={swapKey} className="inline-block max-w-full">
            <Text as="p" variant="body" tone={signedIn ? "success" : "secondary"}>
              {signedIn ? (
                <>
                  <Text as="span" mono tone="inherit">
                    {server}
                  </Text>{" "}
                  {t("signed in")}
                </>
              ) : (
                labelText
              )}
            </Text>
          </Swap>
          {noticeError !== null ? (
            <Text as="p" role="alert" variant="callout" tone="danger">
              {noticeError}
            </Text>
          ) : null}
        </div>
      }
    >
      {showForm ? (
        <form
          className={cn("ms-7 mt-1 flex max-w-xl min-w-0 flex-col gap-1", MOTION_DISCLOSURE_REVEAL)}
          onSubmit={submit}
          autoComplete="off"
        >
          <Text as="p" variant="callout" tone="secondary">
            {t("Paste the address of the page that opened at 127.0.0.1.")}
          </Text>
          <div className="flex min-w-0 items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Input
                aria-label={t("Address the sign-in ended on")}
                aria-invalid={rejected || undefined}
                aria-describedby={fieldError !== null ? `${item.id}-mcp-sign-in-error` : undefined}
                type="text"
                font="mono"
                value={callbackUrl}
                onChange={(event) => setCallbackUrl(event.target.value)}
                readOnly={phase === "completing"}
                placeholder={t("Paste address")}
                autoComplete="off"
                spellCheck={false}
              />
              {fieldError !== null ? (
                <Text
                  as="p"
                  id={`${item.id}-mcp-sign-in-error`}
                  role="alert"
                  variant="callout"
                  tone="danger"
                >
                  {fieldError}
                </Text>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button type="submit" size="xs" variant="primary" disabled={continueDisabled}>
                {phase === "completing" ? <Spinner size="xs" /> : null}
                {phase === "completing" ? t("Signing in") : t("Continue")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={phase === "completing"}
                onClick={() => void begin()}
              >
                {t("Open again")}
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </WorkLogRow>
  );
}
