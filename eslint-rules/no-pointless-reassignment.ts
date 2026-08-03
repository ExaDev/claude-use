import type { Rule, Scope } from "eslint";

type IdentifierNode = Extract<Scope.Reference["identifier"], { type: "Identifier" }>;

/**
 * Detects and auto-fixes redundant alias declarations -- `const foo = bar` where both sides are plain identifiers and the alias adds no transformation. The fixer replaces all reads of the alias with the original name and removes the declaration. Variables prefixed with `_` are exempt (discard convention). Aliases that are written to after declaration are not auto-fixed (scope mutation), and only `const` is flagged -- a `let`/`var` alias is usually an intentional mutable copy.
 */
export const noPointlessReassignmentRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    fixable: "code",
    messages: {
      pointlessReassignment: "Pointless reassignment: '{{ name }}' is just an alias for '{{ value }}'. Use the original directly.",
    },
  },
  create(context) {
    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init?.type !== "Identifier" || node.id.name.startsWith("_")) return;
        if (node.parent.type !== "VariableDeclaration" || node.parent.kind !== "const") return;

        const aliasName = node.id.name;
        const originalName = node.init.name;

        context.report({
          node,
          messageId: "pointlessReassignment",
          data: { name: aliasName, value: originalName },
          fix(fixer) {
            const scope = context.sourceCode.getScope(node);
            const variable = scope.set.get(aliasName);
            if (!variable) return null;

            const mutationRefs = variable.references.filter((r) => r.isWrite() && r.identifier !== node.id);
            if (mutationRefs.length > 0) return null;

            const readRefs = variable.references.filter((r): r is Scope.Reference & { identifier: IdentifierNode } => r.isRead() && r.identifier.type === "Identifier");
            if (readRefs.length !== variable.references.filter((r) => r.isRead()).length) return null;

            // Abort when any read is a shorthand property ({ x } from const x = y) -- rewriting { x } -> { x: original } needs a key change replaceText can't do safely.
            const hasShorthand = readRefs.some((r) => {
              const afterToken = context.sourceCode.getTokenAfter(r.identifier);
              if (afterToken?.value === ":") return false;
              if (afterToken?.value !== "}" && afterToken?.value !== ",") return false;
              let tok = context.sourceCode.getTokenBefore(r.identifier);
              while (tok) {
                if (tok.value === "{") return true;
                if (tok.value === "[" || tok.value === "(") return false;
                if (tok.value === ":") return false;
                tok = context.sourceCode.getTokenBefore(tok);
              }
              return false;
            });
            if (hasShorthand) return null;

            const fixes = readRefs.map((r) => fixer.replaceText(r.identifier, originalName));

            const declaration = node.parent;
            if (declaration.type !== "VariableDeclaration" || declaration.declarations.length !== 1) return null;
            fixes.push(fixer.remove(declaration));
            return fixes;
          },
        });
      },
    };
  },
};
