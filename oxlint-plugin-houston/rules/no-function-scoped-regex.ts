import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

// A callback passed to these runs serialized in a page, where module scope does not exist.
const SERIALIZING_METHODS = new Set([
  "$eval",
  "$$eval",
  "addInitScript",
  "evaluate",
  "evaluateHandle",
  "evaluateOnNewDocument",
  "executeJavaScript",
  "waitForFunction",
]);

const isSerializedCallback = (node: { readonly parent?: unknown }): boolean => {
  const parent = unwrapExpression(node.parent);
  if (Option.isNone(parent) || parent.value.type !== "CallExpression") return false;
  if (!parent.value.arguments.some((argument) => argument === node)) return false;
  const callee = unwrapExpression(parent.value.callee);
  if (Option.isNone(callee)) return false;
  const name =
    callee.value.type === "MemberExpression"
      ? getPropertyName(callee.value.property)
      : callee.value.type === "Identifier"
        ? Option.some(callee.value.name)
        : Option.none<string>();
  return Option.exists(name, (method) => SERIALIZING_METHODS.has(method));
};

const isStaticString = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return false;
  if (expression.value.type === "Literal") return typeof expression.value.value === "string";
  return expression.value.type === "TemplateLiteral" && expression.value.expressions.length === 0;
};

const isStaticRegExpConstruction = (node: {
  readonly callee: unknown;
  readonly arguments: ReadonlyArray<unknown>;
}): boolean =>
  isIdentifier(unwrapExpression(node.callee), "RegExp") &&
  node.arguments.length > 0 &&
  node.arguments.every(isStaticString);

const MESSAGE =
  "Hoist this regex to a module-level const: a regex inside a function is rebuilt on every call. " +
  "A hoisted `g` or `y` regex keeps `lastIndex` between calls, so use it with `replace`, " +
  "`replaceAll`, `matchAll` or `split`, or reset `lastIndex` before `exec` or `test`.";

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow regex literals and static `RegExp` constructions inside functions; hoist them to module scope.",
    },
  },
  createOnce(context) {
    let functionDepth = 0;
    let serializedDepth = 0;
    const serializedStack: Array<boolean> = [];

    const enterFunction = (node: { readonly parent?: unknown }) => {
      functionDepth++;
      const serialized = isSerializedCallback(node);
      serializedStack.push(serialized);
      if (serialized) serializedDepth++;
    };
    const exitFunction = () => {
      functionDepth--;
      if (serializedStack.pop()) serializedDepth--;
    };
    const inFunction = () => functionDepth > 0 && serializedDepth === 0;

    return {
      before() {
        functionDepth = 0;
        serializedDepth = 0;
        serializedStack.length = 0;
      },
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      Literal(node) {
        if (!inFunction() || !("regex" in node) || node.regex === undefined) return;
        context.report({ node, message: MESSAGE });
      },
      NewExpression(node) {
        if (!inFunction() || !isStaticRegExpConstruction(node)) return;
        context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        if (!inFunction() || !isStaticRegExpConstruction(node)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
