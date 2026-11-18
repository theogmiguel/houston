import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";

export interface SourceStateLabel {
  readonly label: string;
  readonly tone: "success" | "error" | "default";
}

export function slackConnectionState(info: HoustonSlackInfo): SourceStateLabel {
  if (!info.enabled) return { label: "Off", tone: "default" };
  if (info.error !== null) return { label: "Failed", tone: "error" };
  if (info.connection === "connected") return { label: "Connected", tone: "success" };
  if (info.connection === "connecting") return { label: "Connecting", tone: "default" };
  if (info.connection === "retrying") return { label: "Retrying", tone: "default" };
  return { label: "Off", tone: "default" };
}

const SLACK_REQUEST_LABELS: Readonly<Record<HoustonSlackRequest["state"], string>> = {
  pending: "Awaiting approval",
  queued: "Queued",
  started: "Started",
  refused: "Refused",
  closed: "Closed",
};

export function slackRequestLabel(request: HoustonSlackRequest): string {
  if (request.state === "queued" && request.queuePosition !== undefined) {
    return `Queued · ${request.queuePosition}`;
  }
  return SLACK_REQUEST_LABELS[request.state];
}

export function slackRequestTone(
  request: HoustonSlackRequest,
): "success" | "error" | "warning" | "info" | "default" {
  switch (request.state) {
    case "started":
      return "success";
    case "refused":
      return "error";
    case "pending":
      return "warning";
    case "queued":
      return "info";
    case "closed":
      return "default";
  }
}
