import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { HoustonProjectFile, HOUSTON_PROJECT_FILE_SCHEMA_URL } from "@houston-app/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const HoustonProjectFileFromJson = fromLenientJson(HoustonProjectFile);

const decodeHoustonProjectFile = Schema.decodeExit(HoustonProjectFileFromJson);

export function parseHoustonProjectFile(contents: string): HoustonProjectFile | null {
  const decoded = decodeHoustonProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildHoustonProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(HoustonProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: HOUSTON_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
