// Registers a linked inference server as a Pi provider routed through Houston's gateway. Pi
// resolves "$HOUSTON_GATEWAY_TOKEN" from the environment itself, so the token never lands in
// argv, settings, or ~/.pi.
export const PI_HOUSTON_GATEWAY_EXTENSION_FILENAME = "pi-houston-gateway-extension.ts";

export const HOUSTON_GATEWAY_URL_ENV = "HOUSTON_GATEWAY_URL";
export const HOUSTON_GATEWAY_TOKEN_ENV = "HOUSTON_GATEWAY_TOKEN";
export const HOUSTON_GATEWAY_PROVIDER_ENV = "HOUSTON_GATEWAY_PROVIDER";
export const HOUSTON_GATEWAY_MODELS_ENV = "HOUSTON_GATEWAY_MODELS";

/** Self-contained so it can sit in both Houston's full extension and the gateway-only one. */
export const PI_HOUSTON_GATEWAY_PROVIDER_SNIPPET = `\
function registerHoustonGatewayProvider(pi: ExtensionAPI) {
  const baseUrl = process.env[${JSON.stringify(HOUSTON_GATEWAY_URL_ENV)}];
  const name = process.env[${JSON.stringify(HOUSTON_GATEWAY_PROVIDER_ENV)}];
  const modelsJson = process.env[${JSON.stringify(HOUSTON_GATEWAY_MODELS_ENV)}];
  if (!baseUrl || !name || !modelsJson || !process.env[${JSON.stringify(HOUSTON_GATEWAY_TOKEN_ENV)}]) return;
  let models: unknown;
  try {
    models = JSON.parse(modelsJson);
  } catch {
    return;
  }
  if (!Array.isArray(models) || models.length === 0) return;
  pi.registerProvider(name, {
    baseUrl,
    apiKey: ${JSON.stringify(`$${HOUSTON_GATEWAY_TOKEN_ENV}`)},
    api: "openai-completions",
    models,
  });
}
`;

export const PI_HOUSTON_GATEWAY_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

${PI_HOUSTON_GATEWAY_PROVIDER_SNIPPET}
export default function houstonGatewayExtension(pi: ExtensionAPI) {
  registerHoustonGatewayProvider(pi);
}
`;
