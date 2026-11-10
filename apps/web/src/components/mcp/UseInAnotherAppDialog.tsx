import {
  AuthMcpClientAccess,
  type EnvironmentId,
  sessionGrantsScope,
} from "@houston-app/contracts";
import { TerminalIcon, WaypointsIcon } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import { useServerConfigs } from "../../state/entities";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useManagedPolicy } from "../../state/managedPolicy";
import { useEnvironmentSessionState } from "../../state/session";
import { mintMcpApprovalCodeOn } from "../../state/peerPairingCode";
import { AccessOption, ChoiceOption } from "../auth/ConnectAgentSurface";
import { CommandBlock } from "../CommandBlock";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { RadioGroup } from "../ui/radio-group";
import { Text } from "../ui/text";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import {
  MCP_CLIENT_APPS,
  OTHER_MCP_CLIENT_STEPS,
  environmentMcpUrl,
  mcpAccessDenial,
  mcpUrlNote,
} from "./mcpClients";

const useRequest = create<{ readonly open: boolean }>(() => ({ open: false }));

/** Opens the wizard for this device's primary environment. */
export function openUseInAnotherApp(): void {
  useRequest.setState({ open: true });
}

const close = () => useRequest.setState({ open: false });

/** Hosted once at the root, so the command palette can open it from anywhere. */
export function UseInAnotherAppDialogHost() {
  const open = useRequest((state) => state.open);
  return open ? <UseInAnotherAppDialog /> : null;
}

const TITLE = "Use Houston in another app (MCP)";
const STEPS = ["App", "Access", "Connect"] as const;
type Step = 0 | 1 | 2;
type Choice = (typeof MCP_CLIENT_APPS)[number]["id"] | "other";

function UseInAnotherAppDialog() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <WizardPopup>
        {environmentId === null ? (
          <>
            <WizardHeader title={TITLE} />
            <WizardPanel>
              <Text as="p" tone="muted">
                Connect to an environment first.
              </Text>
            </WizardPanel>
          </>
        ) : (
          <Wizard key={environmentId} environmentId={environmentId} />
        )}
      </WizardPopup>
    </Dialog>
  );
}

function Wizard({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const session = useEnvironmentSessionState(environmentId).data;
  const policy = useManagedPolicy(environmentId);
  const approvalCodes =
    useServerConfigs().get(environmentId)?.environment.capabilities.mcpApprovalCodes;
  const [step, setStep] = useState<Step>(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [picked, setPicked] = useState<AuthMcpClientAccess | null>(null);

  const denial = (level: AuthMcpClientAccess) =>
    mcpAccessDenial(
      level,
      { has: (scope) => session !== null && sessionGrantsScope(session, scope as never) },
      policy,
    );
  const access =
    picked ?? AuthMcpClientAccess.literals.find((level) => denial(level) === undefined) ?? null;
  const mcpUrl = httpBaseUrl === null ? null : environmentMcpUrl(httpBaseUrl);
  const app = MCP_CLIENT_APPS.find((candidate) => candidate.id === choice);
  const label = environment?.label ?? "Houston";
  const canContinue = step === 0 ? choice !== null : step === 1 ? access !== null : false;

  return (
    <>
      <WizardHeader title={`${TITLE} · ${label}`}>
        <WizardSteps
          steps={STEPS}
          currentStep={step}
          isStepDisabled={(index) => index > step}
          onStepChange={(index) => setStep(index as Step)}
        />
      </WizardHeader>
      <WizardPanel>
        {approvalCodes === false ? (
          <Text as="p" tone="muted">
            This environment is too old to create sign-in codes. Update it, then try again.
          </Text>
        ) : mcpUrl === null ? (
          <Text as="p" tone="muted">
            This environment is not connected, so it has no address to give an app.
          </Text>
        ) : step === 0 ? (
          <RadioGroup
            aria-label="App"
            value={choice ?? ""}
            onValueChange={(value) => setChoice(value as Choice)}
          >
            {MCP_CLIENT_APPS.map((candidate) => (
              <ChoiceOption
                key={candidate.id}
                value={candidate.id}
                label={candidate.name}
                description="Runs on this or another computer you control."
                icon={TerminalIcon}
                selected={choice === candidate.id}
                unavailableReason={undefined}
              />
            ))}
            <ChoiceOption
              value="other"
              label="Something else…"
              description="Any app that supports remote MCP servers with OAuth."
              icon={WaypointsIcon}
              selected={choice === "other"}
              unavailableReason={undefined}
            />
          </RadioGroup>
        ) : step === 1 ? (
          <div className="space-y-2">
            <RadioGroup
              aria-label="What it may do"
              value={access ?? ""}
              onValueChange={(value) => setPicked(value as AuthMcpClientAccess)}
            >
              {AuthMcpClientAccess.literals.map((level) => (
                <AccessOption
                  key={level}
                  access={level}
                  selected={level === access}
                  managedReason={denial(level)}
                />
              ))}
            </RadioGroup>
            <Text as="p" variant="caption" tone="muted">
              Beyond read only, it can start, message and stop threads, and none of them can run
              with more than the mode you pick.
            </Text>
          </div>
        ) : access === null ? null : (
          <ConnectStep
            environmentId={environmentId}
            access={access}
            mcpUrl={mcpUrl}
            commands={app?.commands(mcpUrl) ?? []}
            steps={app === undefined ? OTHER_MCP_CLIENT_STEPS : []}
            note={app?.note}
          />
        )}
      </WizardPanel>
      <WizardFooter
        leading={
          step > 0 ? (
            <Button variant="ghost" onClick={() => setStep((step - 1) as Step)}>
              Back
            </Button>
          ) : undefined
        }
      >
        {step < 2 ? (
          <Button disabled={!canContinue} onClick={() => setStep((step + 1) as Step)}>
            Continue
          </Button>
        ) : (
          <Button onClick={close}>Done</Button>
        )}
      </WizardFooter>
    </>
  );
}

type Code =
  | { readonly status: "idle" }
  | { readonly status: "minting" }
  | { readonly status: "ready"; readonly code: string; readonly minutes: number }
  | { readonly status: "failed"; readonly message: string };

function ConnectStep({
  environmentId,
  access,
  mcpUrl,
  commands,
  steps,
  note,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: AuthMcpClientAccess;
  readonly mcpUrl: string;
  readonly commands: readonly string[];
  readonly steps: readonly string[];
  readonly note: string | undefined;
}) {
  const [code, setCode] = useState<Code>({ status: "idle" });
  const urlNote = mcpUrlNote(mcpUrl);
  const getCode = async () => {
    setCode({ status: "minting" });
    const minted = await mintMcpApprovalCodeOn(environmentId, access);
    if (minted._tag === "Success") {
      const { credential, expiresAtMs } = minted.success;
      setCode({
        status: "ready",
        code: credential,
        minutes: Math.max(1, Math.round((expiresAtMs - Date.now()) / 60_000)),
      });
    } else {
      const reason = minted.failure;
      setCode({
        status: "failed",
        message:
          typeof reason === "object" && reason !== null && "message" in reason
            ? String(reason.message)
            : "Could not create a sign-in code.",
      });
    }
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Text weight="medium">Address</Text>
        <CommandBlock command={mcpUrl} />
        {urlNote === null ? null : (
          <Text as="p" variant="caption" tone="muted">
            {urlNote}
          </Text>
        )}
      </div>
      {commands.length === 0 ? null : (
        <div className="space-y-2">
          <Text weight="medium">Run where the agent runs</Text>
          {commands.map((command) => (
            <CommandBlock key={command} command={command} />
          ))}
          {note === undefined ? null : (
            <Text as="p" variant="caption" tone="muted">
              {note}
            </Text>
          )}
        </div>
      )}
      {steps.length === 0 ? null : (
        <ol className="flex flex-col gap-1">
          {steps.map((step) => (
            <Text as="li" tone="muted" key={step}>
              {step}
            </Text>
          ))}
        </ol>
      )}
      <div className="space-y-2">
        <Text weight="medium">Sign-in code</Text>
        <Text as="p" variant="caption" tone="muted">
          When the app opens the sign-in page, paste this code there. It works once and approves
          only the level you chose.
        </Text>
        {code.status === "ready" ? (
          <div className="space-y-1">
            <CommandBlock command={code.code} />
            <Text as="p" variant="caption" tone="muted">
              Expires in {code.minutes} {code.minutes === 1 ? "minute" : "minutes"}.
            </Text>
          </div>
        ) : (
          <Button
            variant="outline"
            disabled={code.status === "minting"}
            onClick={() => void getCode()}
          >
            {code.status === "minting" ? "Getting code…" : "Get code"}
          </Button>
        )}
        {code.status === "failed" ? (
          <Alert variant="error">
            <AlertDescription>{code.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
