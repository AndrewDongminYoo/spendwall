import { Environment, type ASTNode } from '@marcbachmann/cel-js';

export type PreparedCondition = (
  context: Record<string, unknown>,
  options?: { failClosed: boolean },
) => unknown;

type Runtime = {
  run(node: ASTNode, context: unknown): unknown;
};
type Checker = {
  check(node: ASTNode, context: unknown): unknown;
  getType(name: string): unknown;
};

class Outcome {
  readonly value: unknown;
  readonly failed: boolean;

  constructor(value: unknown, failed: boolean) {
    this.value = value;
    this.failed = failed;
  }
}

function validateUserAst(ast: ASTNode): void {
  const pending: { value: unknown; depth: number }[] = [
    { value: ast, depth: 0 },
  ];
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth });
    } else if (
      value !== null &&
      typeof value === 'object' &&
      'op' in value &&
      'args' in value
    ) {
      if (depth > 64) throw new Error('Excessive CEL AST depth.');
      if (
        value.op === 'call' &&
        Array.isArray(value.args) &&
        value.args[0] === 'spendwall_observe'
      )
        throw new Error('Policy cannot call the internal CEL observer.');
      if (value.op !== 'value' && value.op !== 'id')
        pending.push({ value: value.args, depth: depth + 1 });
    }
  }
}

function observe(runtime: Runtime, ast: ASTNode, context: unknown): Outcome {
  let failed = false;
  let remaining = 10_000;
  let active: ASTNode | undefined;
  const run = (node: ASTNode, scope: unknown): unknown => {
    const parent = active;
    active = node;
    try {
      if (--remaining < 0) throw new Error('CEL operation budget exhausted.');
      const value = runtime.run.call(observer, node, scope);
      if (
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (value instanceof Outcome && value.failed) ||
        ((parent?.op === '||' || parent?.op === '&&') &&
          typeof value !== 'boolean')
      )
        failed = true;
      return value;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      active = parent;
    }
  };
  // Macro runtimes use run/tryEval for visited nodes. Bind the other methods to
  // their original receiver; the library keeps private type state on that object.
  const observer = new Proxy(runtime, {
    get(target, key) {
      if (key === 'run') return run;
      if (key === 'tryEval')
        return (node: ASTNode, scope: unknown): unknown => {
          try {
            return run(node, scope);
          } catch (error) {
            return error;
          }
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const value = run(ast, context);
  return new Outcome(value, failed);
}

// The private macro contributes one parser level and one AST node. Its argument
// is the original policy expression and retains the independent depth check.
const cel = new Environment({
  unlistedVariablesAreDyn: true,
  limits: { maxDepth: 65, maxAstNodes: 4_097 },
}).registerFunction(
  'spendwall_observe(ast): dyn',
  ({ args }: { args: ASTNode[] }) => {
    if (args.length !== 1) throw new Error('Invalid internal CEL wrapper.');
    const ast = args[0]!;
    validateUserAst(ast);
    return {
      args,
      async: false,
      typeCheck(checker: Checker, _macro: unknown, context: unknown) {
        checker.check(ast, context);
        return checker.getType('dyn');
      },
      evaluate(runtime: Runtime, _macro: unknown, context: unknown) {
        return observe(runtime, ast, context);
      },
    };
  },
);

export function prepareCondition(source: string): PreparedCondition {
  const expression = cel.parse(`spendwall_observe(\n${source}\n)`);
  if (
    expression.ast.op !== 'call' ||
    expression.ast.args[0] !== 'spendwall_observe' ||
    expression.ast.args[1].length !== 1
  )
    throw new Error('Policy expression escaped its CEL wrapper.');
  return Object.freeze(
    (
      context: Record<string, unknown>,
      options?: { failClosed: boolean },
    ): unknown => {
      const outcome: unknown = expression(context);
      if (!(outcome instanceof Outcome))
        throw new Error('Invalid CEL evaluation result.');
      if (
        options?.failClosed &&
        (outcome.failed || outcome.value instanceof Promise)
      )
        throw new Error('CEL evaluation encountered an error.');
      return outcome.value;
    },
  );
}
