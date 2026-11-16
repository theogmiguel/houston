import { makeSecretProviderDefinitionRegistry } from "@houston-app/secret-provider-core/shared/definition";
import * as OnePassword from "@houston-app/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
