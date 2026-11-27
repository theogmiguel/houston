import * as Schema from "effect/Schema";

/**
 * What Settings > Browser needs to show the one-time host setup: whether this
 * server's host blocks Chrome's sandbox, and the command that fixes it.
 */
export const HoustonPreviewBrowserHost = Schema.Struct({
  blocked: Schema.Boolean,
  setupCommand: Schema.String,
});
export type HoustonPreviewBrowserHost = typeof HoustonPreviewBrowserHost.Type;
