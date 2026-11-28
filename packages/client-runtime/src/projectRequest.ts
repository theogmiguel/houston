import type {
  HoustonProjectRequestAnswerInput,
  OrchestrationV2TurnItem,
} from "@houston-app/contracts";

export type ProjectRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "project_request" }
>;

/** What the card says after an answer, or while the one approved call runs. */
export type ProjectRequestDisplay =
  | { readonly kind: "pending"; readonly adding: boolean }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "added" | "declined" | "cancelled" | "failed";
      readonly label: string;
    };

const PENDING_ELSEWHERE_DISPLAY: ProjectRequestDisplay = {
  kind: "pending-elsewhere",
  label: "Waiting for an answer in the original thread",
};

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function projectRequestDisplay(
  item: Pick<ProjectRequestItem, "projectRequestStatus">,
  visibility: "local" | "inherited" | "synthetic",
): ProjectRequestDisplay {
  switch (item.projectRequestStatus) {
    case "pending":
    case "adding":
      return visibility === "local"
        ? { kind: "pending", adding: item.projectRequestStatus === "adding" }
        : PENDING_ELSEWHERE_DISPLAY;
    case "added":
      return { kind: "answered", outcome: "added", label: "Added" };
    case "declined":
      return { kind: "answered", outcome: "declined", label: "Declined" };
    case "cancelled":
      return { kind: "answered", outcome: "cancelled", label: "Cancelled" };
    case "failed":
      return { kind: "answered", outcome: "failed", label: "Could not add" };
  }
}

export function projectRequestAnswerInput(
  item: Pick<ProjectRequestItem, "id" | "threadId">,
  answer: "approve" | "decline",
): HoustonProjectRequestAnswerInput {
  return {
    threadId: item.threadId,
    turnItemId: item.id,
    answer: answer === "approve" ? { type: "approve" } : { type: "decline" },
  };
}

const USER_FACING_FAILURE_TAGS = new Set([
  "HoustonProjectRequestError",
  "EnvironmentAuthorizationError",
]);

/** Only known server errors pass their message through; anything else gets generic copy. */
export function projectRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
