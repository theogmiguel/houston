import { defineRule, type ESTree } from "@oxlint/plugins";

// Object literals passed to these calls are callbacks or schemas, not service objects.
const SERVICE_FACTORIES = new Set(["of", "succeed", "sync", "make"]);
const COMBINATOR_CALLEE =
  /^(catchTags?|catchIf|match\w*|orElse\w*|tap\w*|all|forEach|when\w*|retry|repeat|timeout\w*|acquireRelease|ensuring|onExit|onError|mapError|Struct|Union|Class|TaggedClass|TaggedError|toHandlers)$/;
const COMBINATOR_NAMESPACES = new Set(["Match", "Schema", "Config"]);
const HOUSTON_SPAN_NAME = /^[A-Z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const MIN_REASON_LENGTH = 10;

type Fn = ESTree.ArrowFunctionExpression | ESTree.Function;
type Node = ESTree.Node;

const unwrap = (node: Node): Node => {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const isFunction = (node: Node): node is Fn =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration";

const calleeName = (callee: Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
};

const calleeNamespace = (callee: Node): string | undefined =>
  callee.type === "MemberExpression" && callee.object.type === "Identifier"
    ? callee.object.name
    : undefined;

const isCombinatorCall = (call: ESTree.CallExpression): boolean => {
  let callee: Node = call.callee;
  while (callee.type === "CallExpression") callee = callee.callee;
  const name = calleeName(callee);
  const namespace = calleeNamespace(callee);
  return (
    (name !== undefined && COMBINATOR_CALLEE.test(name)) ||
    (namespace !== undefined && COMBINATOR_NAMESPACES.has(namespace))
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Exported and service-member functions that return an Effect, Stream or Promise are traced at their definition.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    // Absolute paths can contain a checkout directory named houston; match below src/ only.
    const houstonFile = /\/src\/(?:.+\/)?houston\//.test(filename);
    const reported = new Set<Node>();

    // Resolves an identifier to the effect module it imports, or undefined.
    const effectModuleOf = (identifier: ESTree.IdentifierReference): string | undefined => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          for (const def of variable.defs) {
            if (def.type !== "ImportBinding" || def.parent?.type !== "ImportDeclaration") continue;
            const source = def.parent.source.value;
            if (def.node.type === "ImportNamespaceSpecifier" && source.startsWith("effect/")) {
              return source.slice("effect/".length);
            }
            if (source === "effect" && def.node.type === "ImportSpecifier") {
              const imported = def.node.imported;
              return imported.type === "Identifier" ? imported.name : imported.value;
            }
          }
          return undefined;
        }
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    };

    // `Effect.fn(...)` / `Effect.fnUntraced(...)` at the root of a definition's value.
    const effectFnForm = (
      value: Node,
    ):
      | { kind: "named"; name: string | undefined }
      | { kind: "anonymous" }
      | { kind: "untraced" }
      | undefined => {
      let node = unwrap(value);
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        calleeName(node.callee) === "pipe"
      ) {
        node = unwrap(node.callee.object);
      }
      if (node.type !== "CallExpression") return undefined;
      let inner: ESTree.CallExpression = node;
      while (inner.callee.type === "CallExpression") inner = inner.callee;
      const callee = inner.callee;
      if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier")
        return undefined;
      if (effectModuleOf(callee.object) !== "Effect") return undefined;
      const member = calleeName(callee);
      if (member === "fnUntraced") return { kind: "untraced" };
      if (member !== "fn") return undefined;
      const first = inner.arguments[0];
      if (first === undefined || isFunction(unwrap(first))) return { kind: "anonymous" };
      if (first.type === "Literal" && typeof first.value === "string") {
        return first.value.length > 0
          ? { kind: "named", name: first.value }
          : { kind: "anonymous" };
      }
      return { kind: "named", name: undefined };
    };

    const rootKind = (expression: Node): "effect" | "promise" | undefined => {
      let node = unwrap(expression);
      if (node.type === "ConditionalExpression") {
        return rootKind(node.consequent) ?? rootKind(node.alternate);
      }
      if (node.type === "NewExpression") {
        return node.callee.type === "Identifier" && node.callee.name === "Promise"
          ? "promise"
          : undefined;
      }
      while (true) {
        if (node.type === "CallExpression") {
          const callee = unwrap(node.callee);
          node =
            callee.type === "MemberExpression" && calleeName(callee) === "pipe"
              ? unwrap(callee.object)
              : callee;
          continue;
        }
        if (node.type === "MemberExpression" && node.object.type !== "Identifier") {
          node = unwrap(node.object);
          continue;
        }
        break;
      }
      if (node.type !== "MemberExpression" || node.object.type !== "Identifier") return undefined;
      if (node.object.name === "Promise") return "promise";
      const module = effectModuleOf(node.object);
      if (module !== "Effect" && module !== "Stream") return undefined;
      const member = calleeName(node) ?? "";
      if (module === "Effect" && /^(run|fn$|fnUntraced$|[A-Z])/.test(member)) return undefined;
      return "effect";
    };

    const returnExpressions = (fn: Fn): Array<Node> => {
      const body = fn.body;
      if (body === null || body === undefined) return [];
      if (body.type !== "BlockStatement") return [body];
      const found: Array<Node> = [];
      const visit = (node: unknown) => {
        if (typeof node !== "object" || node === null) return;
        if (Array.isArray(node)) {
          for (const child of node) visit(child);
          return;
        }
        const typed = node as Node;
        if (typeof typed.type !== "string") return;
        if (isFunction(typed) || typed.type === "ClassBody") return;
        if (typed.type === "ReturnStatement") {
          if (typed.argument !== null) found.push(typed.argument);
          return;
        }
        for (const key of Object.keys(typed)) {
          if (key === "parent") continue;
          visit((typed as unknown as Record<string, unknown>)[key]);
        }
      };
      visit(body.body);
      return found;
    };

    const isEffectful = (fn: Fn): boolean => {
      if (fn.generator) return false;
      if (fn.async) return true;
      if (fn.returnType) {
        const annotation = context.sourceCode.getText(fn.returnType);
        if (/\b(Effect\.Effect|Stream\.Stream)\b|^:\s*Promise</.test(annotation)) return true;
      }
      return returnExpressions(fn).some((expression) => rootKind(expression) !== undefined);
    };

    // The statement whose leading comment documents the definition.
    const commentAnchor = (site: Node): Node => {
      if (site.type === "VariableDeclarator") {
        const declaration = site.parent;
        return declaration.parent?.type === "ExportNamedDeclaration"
          ? declaration.parent
          : declaration;
      }
      return site;
    };

    const hasReasonComment = (site: Node): boolean =>
      context.sourceCode
        .getCommentsBefore(commentAnchor(site))
        .some(
          (comment) =>
            !/^\s*(oxlint|eslint)-/.test(comment.value) &&
            comment.value.trim().length >= MIN_REASON_LENGTH,
        );

    const report = (site: Node, message: string) => {
      if (reported.has(site)) return;
      reported.add(site);
      context.report({ node: site, message });
    };

    const check = (site: Node, name: string, value: Node) => {
      const form = effectFnForm(value);
      if (form !== undefined) {
        if (form.kind === "anonymous") {
          report(
            site,
            `'${name}' uses an anonymous Effect.fn, which records no span: name it, e.g. Effect.fn("Module.${name}").`,
          );
        } else if (form.kind === "untraced" && !hasReasonComment(site)) {
          report(
            site,
            `'${name}' is public and uses Effect.fnUntraced without a reason: add a comment saying why it has no span, or use Effect.fn("Module.${name}").`,
          );
        } else if (
          form.kind === "named" &&
          houstonFile &&
          form.name !== undefined &&
          !HOUSTON_SPAN_NAME.test(form.name)
        ) {
          report(
            site,
            `Span name '${form.name}' does not match Module.operation (${HOUSTON_SPAN_NAME.source}).`,
          );
        }
        return;
      }
      const fn = unwrap(value);
      if (!isFunction(fn) || !isEffectful(fn)) return;
      report(
        site,
        `'${name}' is public and returns an Effect, Stream or Promise but is not traced at its definition: wrap it in Effect.fn("Module.${name}"), or use Effect.fnUntraced with a comment saying why.`,
      );
    };

    const isServiceObject = (object: ESTree.ObjectExpression): boolean => {
      let node: Node = object;
      let parent: Node | null = object.parent;
      while (
        parent !== null &&
        (parent.type === "ParenthesizedExpression" ||
          parent.type === "TSAsExpression" ||
          parent.type === "TSSatisfiesExpression")
      ) {
        node = parent;
        parent = parent.parent;
      }
      if (parent === null) return false;
      switch (parent.type) {
        case "ReturnStatement":
          return true;
        case "ArrowFunctionExpression": {
          if (parent.body !== node) return false;
          const call = parent.parent;
          return !(call?.type === "CallExpression" && isCombinatorCall(call));
        }
        case "VariableDeclarator":
          return parent.init === node && parent.parent.parent?.type === "ExportNamedDeclaration";
        case "CallExpression": {
          if (!parent.arguments.includes(node as ESTree.Expression)) return false;
          let callee: Node = parent.callee;
          while (callee.type === "CallExpression") callee = callee.callee;
          const name = calleeName(callee);
          return name !== undefined && SERVICE_FACTORIES.has(name) && !isCombinatorCall(parent);
        }
        case "Property":
          return (
            parent.value === node &&
            parent.parent.type === "ObjectExpression" &&
            isServiceObject(parent.parent)
          );
        default:
          return false;
      }
    };

    const keyName = (key: Node): string | undefined =>
      key.type === "Identifier"
        ? key.name
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : undefined;

    // `{ read }` or `{ read: read }` in a service object: check the local definition.
    const checkReferencedLocal = (
      identifier: ESTree.IdentifierReference | ESTree.BindingIdentifier,
    ) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          for (const def of variable.defs) {
            if (def.type === "Variable" && def.node.type === "VariableDeclarator") {
              const declarator = def.node;
              if (declarator.id.type === "Identifier" && declarator.init) {
                check(declarator, identifier.name, declarator.init);
              }
            } else if (def.type === "FunctionName" && def.node.type === "FunctionDeclaration") {
              check(def.node, identifier.name, def.node);
            }
          }
          return;
        }
        if (scope.upper === null) return;
        scope = scope.upper;
      }
    };

    const isExportedClass = (classBody: Node): boolean => {
      if (classBody.type !== "ClassBody") return false;
      const klass = classBody.parent;
      const parent = klass.parent;
      if (parent === null) return false;
      if (parent.type === "ExportNamedDeclaration" || parent.type === "ExportDefaultDeclaration") {
        return true;
      }
      return (
        parent.type === "VariableDeclarator" &&
        parent.parent.parent?.type === "ExportNamedDeclaration"
      );
    };

    const isPrivateMember = (member: ESTree.MethodDefinition | ESTree.PropertyDefinition) =>
      member.key.type === "PrivateIdentifier" || member.accessibility === "private";

    return {
      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        if (declaration === null || declaration === undefined) return;
        if (declaration.type === "FunctionDeclaration" && declaration.id) {
          check(declaration, declaration.id.name, declaration);
        } else if (declaration.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations) {
            if (declarator.id.type === "Identifier" && declarator.init) {
              check(declarator, declarator.id.name, declarator.init);
            }
          }
        }
      },
      ExportDefaultDeclaration(node) {
        const declaration = node.declaration;
        if (declaration.type === "FunctionDeclaration") {
          check(declaration, declaration.id?.name ?? "default", declaration);
        }
      },
      Property(node) {
        if (node.kind !== "init" || node.computed) return;
        if (node.parent.type !== "ObjectExpression" || !isServiceObject(node.parent)) return;
        const name = keyName(node.key);
        if (name === undefined) return;
        const value = unwrap(node.value);
        if (value.type === "Identifier") {
          checkReferencedLocal(value);
          return;
        }
        check(node, name, node.value);
      },
      MethodDefinition(node) {
        if (node.kind !== "method" || isPrivateMember(node)) return;
        if (!isExportedClass(node.parent)) return;
        const name = keyName(node.key);
        if (name !== undefined) check(node, name, node.value);
      },
      PropertyDefinition(node) {
        if (node.value === null || isPrivateMember(node)) return;
        if (!isExportedClass(node.parent)) return;
        const name = keyName(node.key);
        if (name !== undefined) check(node, name, node.value);
      },
    };
  },
});
