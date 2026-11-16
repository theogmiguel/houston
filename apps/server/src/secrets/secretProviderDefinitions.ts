import { builtInSecretProviderDefinitions } from "@houston-app/secret-provider-definitions/registry";
import * as OnePasswordDriver from "@houston-app/secret-provider-onepassword/server/driver";

/** In the shared registry's order. */
export const BUILT_IN_SECRET_PROVIDER_DRIVER_LIST = [OnePasswordDriver.driver] as const;

export const secretProviderDefinitions = builtInSecretProviderDefinitions;
