import { HoustonBlockingBackgroundWork } from "@houston-app/contracts/houston/backgroundWork";
import * as Schema from "effect/Schema";

/** A provider switch refused because the session still runs work that switching would end. */
export class BackgroundWorkBlocksProviderSwitchError extends Schema.TaggedError<BackgroundWorkBlocksProviderSwitchError>()(
  "BackgroundWorkBlocksProviderSwitchError",
  {
    message: Schema.String,
    items: Schema.Array(HoustonBlockingBackgroundWork),
  },
) {}
