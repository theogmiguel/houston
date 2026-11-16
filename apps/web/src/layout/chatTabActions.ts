/**
 * What a chat tab offers its context menu beyond the layout's own items. The chat registers
 * these while it is mounted, because a layout pane draws no header row to hold them.
 */
export interface ChatTabActions {
  readonly findInThread: (() => void) | null;
  readonly openProjectSettings: (() => void) | null;
}

const actionsByTabId = new Map<string, ChatTabActions>();

export function registerChatTabActions(tabId: string, actions: ChatTabActions): () => void {
  actionsByTabId.set(tabId, actions);
  return () => {
    if (actionsByTabId.get(tabId) === actions) actionsByTabId.delete(tabId);
  };
}

export function chatTabActions(tabId: string): ChatTabActions | null {
  return actionsByTabId.get(tabId) ?? null;
}
