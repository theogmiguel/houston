import { defineRule, type ESTree } from "@oxlint/plugins";

// Object literals passed to these calls are callbacks or schemas, not service objects.
const SERVICE_FACTORIES = new Set(["of", "succeed", "sync", "make"]);
const COMBINATOR_CALLEE =
  /^(catchTags?|catchIf|match\w*|orElse\w*|tap\w*|all|forEach|when\w*|retry|repeat|timeout\w*|acquireRelease|ensuring|onExit|onError|mapError|map|flatMap|andThen|Struct|Union|Class|TaggedClass|TaggedError|toHandlers)$/;
const COMBINATOR_NAMESPACES = new Set(["Match", "Schema", "Config"]);
const HOUSTON_SPAN_NAME = /^[A-Z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const MIN_REASON_LENGTH = 10;
// A reason says why the definition has no span of its own: it names the span or tracing, or a
// hot path that runs per (or on every) unit of work, which one qualifier word may precede.
// "Cached per project" or "the caller owns the scope" do not.
const NO_SPAN_REASON =
  /\b(spans?|(un)?trac(e|ed|es|ing)|hot[ -]?path|(per|every)[ -]([\w-]+ )?(event|chunk|message|item|frame|row|request|call|line|tick|byte|token|delta|record|statement|query|update|entry|sample)s?)\b/i;
// Bodies passed to these calls build a value, possibly a service object.
const FACTORY_BODY_CALLEES = new Set(["gen", "fn", "fnUntraced"]);
// Callbacks of these calls build a service when the call feeds a layer.
const BUILDER_CALLEES = new Set(["map", "flatMap", "andThen"]);
const FACTORY_NAME = /^make([A-Z]|$)/;

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

const isWrapper = (node: Node) =>
  node.type === "ParenthesizedExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "TSSatisfiesExpression";

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

const innermostCallee = (call: ESTree.CallExpression): Node => {
  let callee: Node = call.callee;
  while (callee.type === "CallExpression") callee = callee.callee;
  return callee;
};

const isCombinatorCall = (call: ESTree.CallExpression): boolean => {
  const callee = innermostCallee(call);
  const name = calleeName(callee);
  const namespace = calleeNamespace(callee);
  return (
    (name !== undefined && COMBINATOR_CALLEE.test(name)) ||
    (namespace !== undefined && COMBINATOR_NAMESPACES.has(namespace))
  );
};

const keyName = (key: Node): string | undefined =>
  key.type === "Identifier"
    ? key.name
    : key.type === "Literal" && typeof key.value === "string"
      ? key.value
      : undefined;

const enclosingFunction = (node: Node): Fn | undefined => {
  let current: Node | null = node.parent;
  while (current !== null && !isFunction(current)) current = current.parent;
  return current ?? undefined;
};

const isExportedDeclarator = (declarator: ESTree.VariableDeclarator) =>
  declarator.parent.parent?.type === "ExportNamedDeclaration";

const declaratorName = (declarator: ESTree.VariableDeclarator) =>
  declarator.id.type === "Identifier" ? declarator.id.name : "";

const isExportedClass = (classBody: Node): boolean => {
  if (classBody.type !== "ClassBody") return false;
  const parent = classBody.parent.parent;
  if (parent === null) return false;
  if (parent.type === "ExportNamedDeclaration" || parent.type === "ExportDefaultDeclaration") {
    return true;
  }
  return parent.type === "VariableDeclarator" && isExportedDeclarator(parent);
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

    // The import an identifier is bound to: its source and imported name ("*" for a namespace).
    const importOf = (
      identifier: ESTree.IdentifierReference | ESTree.BindingIdentifier,
    ): { readonly source: string; readonly imported: string } | undefined => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) {
          for (const def of variable.defs) {
            if (def.type !== "ImportBinding" || def.parent?.type !== "ImportDeclaration") continue;
            const source = def.parent.source.value;
            if (def.node.type === "ImportNamespaceSpecifier") return { source, imported: "*" };
            if (def.node.type === "ImportSpecifier") {
              const imported = def.node.imported;
              return {
                source,
                imported: imported.type === "Identifier" ? imported.name : imported.value,
              };
            }
          }
          return undefined;
        }
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    };

    // Resolves an identifier to the effect module it imports, or undefined.
    const effectModuleOf = (identifier: ESTree.IdentifierReference): string | undefined => {
      const binding = importOf(identifier);
      if (binding === undefined) return undefined;
      if (binding.imported === "*") {
        return binding.source.startsWith("effect/")
          ? binding.source.slice("effect/".length)
          : undefined;
      }
      return binding.source === "effect" ? binding.imported : undefined;
    };

    // `pipe(a, f, g)` from effect or effect/Function starts from its first argument.
    const isPipeFunction = (callee: Node): boolean => {
      if (callee.type === "Identifier") {
        const binding = importOf(callee);
        return (
          binding !== undefined &&
          binding.imported === "pipe" &&
          (binding.source === "effect" || binding.source === "effect/Function")
        );
      }
      return (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        calleeName(callee) === "pipe" &&
        effectModuleOf(callee.object) === "Function"
      );
    };

    const pipeStart = (node: Node): Node | undefined => {
      if (node.type !== "CallExpression" || !isPipeFunction(unwrap(node.callee))) return undefined;
      const first = node.arguments[0];
      return first === undefined || first.type === "SpreadElement" ? undefined : unwrap(first);
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
      } else {
        node = pipeStart(node) ?? node;
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
          const start = pipeStart(node);
          if (start !== undefined) {
            node = start;
            continue;
          }
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

    // Before the declaration, or between `=` and the initializer.
    const hasReasonComment = (site: Node): boolean =>
      [
        ...context.sourceCode.getCommentsBefore(commentAnchor(site)),
        ...(site.type === "VariableDeclarator" && site.init
          ? context.sourceCode.getCommentsBefore(site.init)
          : []),
      ].some(
        (comment) =>
          !/^\s*(oxlint|eslint)-/.test(comment.value) &&
          comment.value.trim().length >= MIN_REASON_LENGTH &&
          NO_SPAN_REASON.test(comment.value),
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
            `'${name}' is public and uses Effect.fnUntraced without a reason: add a comment saying why it has no span (an enclosing span owns it, a hot or per-event path), or use Effect.fn("Module.${name}").`,
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

    const isLayerCall = (node: Node): boolean =>
      node.type === "CallExpression" && calleeNamespace(innermostCallee(node)) === "Layer";

    // `value.pipe(..., Layer.effect(Tag))`: the call whose callee is `value.pipe`, or undefined.
    const pipeMethodCall = (value: Node): ESTree.CallExpression | undefined => {
      const member = value.parent;
      if (member?.type !== "MemberExpression" || member.object !== value) return undefined;
      if (calleeName(member) !== "pipe") return undefined;
      const call = member.parent;
      return call?.type === "CallExpression" && call.callee === member ? call : undefined;
    };

    const hasLayerArgument = (call: ESTree.CallExpression, except?: Node): boolean =>
      call.arguments.some((argument) => argument !== except && isLayerCall(unwrap(argument)));

    const variableOf = (identifier: ESTree.BindingIdentifier) => {
      let scope = context.sourceCode.getScope(identifier);
      while (true) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) return variable;
        if (scope.upper === null) return undefined;
        scope = scope.upper;
      }
    };

    // A local binding feeds a factory when one of its references does: `Layer.effect(Tag, live)`.
    const resolving = new Set<Node>();
    const referencesFeed = (
      id: ESTree.BindingIdentifier,
      feeds: (reference: Node) => boolean,
    ): boolean => {
      if (resolving.has(id)) return false;
      const variable = variableOf(id);
      if (variable === undefined) return false;
      resolving.add(id);
      try {
        return variable.references.some(
          (reference) => reference.identifier !== id && feeds(reference.identifier as Node),
        );
      } finally {
        resolving.delete(id);
      }
    };

    const bindingFeeds = (
      declarator: ESTree.VariableDeclarator,
      feeds: (reference: Node) => boolean,
    ): boolean => declarator.id.type === "Identifier" && referencesFeed(declarator.id, feeds);

    // A value that becomes a member of a service object, directly or through a local binding.
    const feedsServiceObject = (start: Node): boolean => {
      let node = start;
      let parent: Node | null = node.parent;
      while (parent !== null && isWrapper(parent)) {
        node = parent;
        parent = parent.parent;
      }
      if (parent?.type === "Property") {
        return (
          parent.value === node &&
          parent.parent.type === "ObjectExpression" &&
          isServiceObject(parent.parent)
        );
      }
      if (parent?.type === "VariableDeclarator" && parent.init === node) {
        return !isExportedDeclarator(parent) && bindingFeeds(parent, feedsServiceObject);
      }
      return false;
    };

    // A private helper builds a service when a call to it becomes a service member.
    const isCalledIntoService = (reference: Node): boolean =>
      reference.parent?.type === "CallExpression" &&
      reference.parent.callee === reference &&
      feedsServiceObject(reference.parent);

    // Whether a value flows into a `Layer.*` call, directly, through pipes or a local binding.
    const feedsLayer = (start: Node): boolean => {
      let node = start;
      while (true) {
        const parent: Node | null = node.parent;
        if (parent === null) return false;
        if (isWrapper(parent)) {
          node = parent;
          continue;
        }
        const piped = pipeMethodCall(node);
        if (piped !== undefined) {
          if (hasLayerArgument(piped)) return true;
          node = piped;
          continue;
        }
        if (
          parent.type === "CallExpression" &&
          parent.arguments.includes(node as ESTree.Expression)
        ) {
          if (calleeNamespace(innermostCallee(parent)) === "Layer") return true;
          const callee = unwrap(parent.callee);
          const isPipe =
            (callee.type === "MemberExpression" && calleeName(callee) === "pipe") ||
            isPipeFunction(callee);
          if (!isPipe) return false;
          if (hasLayerArgument(parent, node)) return true;
          node = parent;
          continue;
        }
        if (parent.type === "VariableDeclarator" && parent.init === node) {
          return bindingFeeds(parent, feedsLayer);
        }
        return false;
      }
    };

    // An object literal reachable from an export: an exported binding's value, an argument of an
    // exported call or of an exported class's base, or a property value of such an object.
    const isExportedObject = (object: Node): boolean => {
      let node = object;
      while (true) {
        const parent: Node | null = node.parent;
        if (parent === null) return false;
        if (isWrapper(parent)) {
          node = parent;
          continue;
        }
        switch (parent.type) {
          case "VariableDeclarator":
            return parent.init === node && isExportedDeclarator(parent);
          case "ExportDefaultDeclaration":
            return true;
          case "Property":
            if (parent.value !== node) return false;
            node = parent.parent;
            continue;
          case "CallExpression":
            if (!parent.arguments.includes(node as ESTree.Expression) && parent.callee !== node) {
              return false;
            }
            if (isCombinatorCall(parent)) return false;
            node = parent;
            continue;
          case "ClassDeclaration":
          case "ClassExpression":
            return parent.superClass === node && isExportedClass(parent.body);
          default:
            return false;
        }
      }
    };

    // A map, flatMap or andThen callback builds a service when its call feeds a layer.
    const isBuilderCallback = (fn: Node, call: ESTree.CallExpression): boolean =>
      call.arguments.includes(fn as ESTree.Expression) &&
      BUILDER_CALLEES.has(calleeName(innermostCallee(call)) ?? "") &&
      feedsLayer(call);

    // A value built by an Effect.gen / Effect.fn call is a service when that call feeds a layer,
    // an exported, `make*` or layer-fed binding, an option of a service or exported object, a
    // class member or a public function.
    const isFactoryCall = (start: Node): boolean => {
      let call: Node = start;
      while (true) {
        const parent: Node | null = call.parent;
        if (parent === null) return false;
        if (isWrapper(parent)) {
          call = parent;
          continue;
        }
        const piped = pipeMethodCall(call);
        if (piped !== undefined) {
          if (hasLayerArgument(piped)) return true;
          call = piped;
          continue;
        }
        switch (parent.type) {
          case "CallExpression": {
            const callee = innermostCallee(parent);
            if (calleeNamespace(callee) === "Layer") return true;
            if (!isPipeFunction(unwrap(callee))) return false;
            return hasLayerArgument(parent, call) || isFactoryCall(parent);
          }
          case "VariableDeclarator":
            return (
              parent.init === call &&
              (isExportedDeclarator(parent) ||
                FACTORY_NAME.test(declaratorName(parent)) ||
                bindingFeeds(parent, isFactoryCall))
            );
          case "Property":
            return (
              parent.value === call &&
              parent.parent.type === "ObjectExpression" &&
              (keyName(parent.key) === "make" ||
                isServiceObject(parent.parent) ||
                isExportedObject(parent.parent))
            );
          case "PropertyDefinition":
            return parent.static === true || isExportedClass(parent.parent);
          case "ReturnStatement": {
            const fn = enclosingFunction(parent);
            return fn !== undefined && isPublicFunction(fn);
          }
          case "ArrowFunctionExpression":
            return parent.body === call && isPublicFunction(parent);
          case "ExportDefaultDeclaration":
            return true;
          default:
            return false;
        }
      }
    };

    // Whether a function's own binding makes it public or a service factory.
    const isPublicFunction = (fn: Fn): boolean => {
      if (fn.type === "FunctionDeclaration") {
        const parent = fn.parent;
        return (
          parent?.type === "ExportNamedDeclaration" ||
          parent?.type === "ExportDefaultDeclaration" ||
          FACTORY_NAME.test(fn.id?.name ?? "") ||
          (fn.id !== null && fn.id !== undefined && referencesFeed(fn.id, isCalledIntoService))
        );
      }
      let node: Node = fn;
      let parent: Node | null = fn.parent;
      while (parent !== null && isWrapper(parent)) {
        node = parent;
        parent = parent.parent;
      }
      if (parent === null) return false;
      switch (parent.type) {
        case "ExportDefaultDeclaration":
          return true;
        case "VariableDeclarator":
          return (
            isExportedDeclarator(parent) ||
            FACTORY_NAME.test(declaratorName(parent)) ||
            bindingFeeds(parent, isCalledIntoService)
          );
        case "Property":
          return (
            parent.value === node &&
            parent.parent.type === "ObjectExpression" &&
            isServiceObject(parent.parent)
          );
        case "MethodDefinition":
        case "PropertyDefinition":
          return isExportedClass(parent.parent);
        case "CallExpression": {
          if (!parent.arguments.includes(node as ESTree.Expression)) return false;
          const name = calleeName(innermostCallee(parent));
          if (name !== undefined && FACTORY_BODY_CALLEES.has(name)) return isFactoryCall(parent);
          return isBuilderCallback(node, parent);
        }
        default:
          return false;
      }
    };

    const isServiceObject = (object: ESTree.ObjectExpression): boolean => {
      let node: Node = object;
      let parent: Node | null = object.parent;
      while (parent !== null && isWrapper(parent)) {
        node = parent;
        parent = parent.parent;
      }
      if (parent === null) return false;
      switch (parent.type) {
        case "ReturnStatement": {
          const fn = enclosingFunction(parent);
          return fn !== undefined && isPublicFunction(fn);
        }
        case "ArrowFunctionExpression": {
          if (parent.body !== node) return false;
          const call = parent.parent;
          if (call?.type === "CallExpression" && isCombinatorCall(call)) {
            return isBuilderCallback(parent, call);
          }
          return isPublicFunction(parent);
        }
        case "VariableDeclarator":
          return parent.init === node && isExportedDeclarator(parent);
        case "CallExpression": {
          if (!parent.arguments.includes(node as ESTree.Expression)) return false;
          const name = calleeName(innermostCallee(parent));
          if (name === undefined || !SERVICE_FACTORIES.has(name) || isCombinatorCall(parent)) {
            return false;
          }
          // `Tag.of` always builds a service; `succeed`, `sync` and `make` only at module level or
          // inside a public function or service factory, not in a callback.
          if (name === "of") return true;
          const fn = enclosingFunction(parent);
          return fn === undefined || isPublicFunction(fn);
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

    // `{ read }`, `{ read: read }` or `export { read }`: check the local definition.
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

    const isPrivateMember = (member: ESTree.MethodDefinition | ESTree.PropertyDefinition) =>
      member.key.type === "PrivateIdentifier" || member.accessibility === "private";

    return {
      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        if (declaration === null || declaration === undefined) {
          // `export { f }` and `export { f as g }` of a local definition; re-exports are skipped.
          if (node.source !== null && node.source !== undefined) return;
          for (const specifier of node.specifiers) {
            if (specifier.local.type === "Identifier") checkReferencedLocal(specifier.local);
          }
          return;
        }
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
          return;
        }
        if (declaration.type === "ClassDeclaration") return;
        const value = unwrap(declaration);
        if (value.type === "Identifier") {
          checkReferencedLocal(value);
          return;
        }
        check(declaration, "default", declaration);
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
