type Rule = Readonly<{ id: string }>;
const prefix = 'rules.v1';
function invalid(): never {
  throw new Error('Invalid audit rule references.');
}

function encodePositions(positions: readonly number[]): string[] {
  const chunks: string[] = [];
  let chunk = prefix;
  let previous = -1;
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 0 || position <= previous)
      invalid();
    previous = position;
    const token = `:${position.toString(36)}`;
    if (chunk.length + token.length > 128) {
      chunks.push(chunk);
      chunk = prefix;
    }
    chunk += token;
    if (chunk.length > 128 || chunks.length >= 128) invalid();
  }
  if (chunk !== prefix) chunks.push(chunk);
  return chunks;
}

export function parseRuleReferences(refs: readonly string[]): number[] {
  if (!Array.isArray(refs) || refs.length > 128) invalid();
  const positions: number[] = [];
  for (const ref of refs) {
    if (
      typeof ref !== 'string' ||
      ref.length > 128 ||
      !/^rules\.v1(?::[0-9a-z]+)+$/.test(ref)
    )
      invalid();
    for (const token of ref.slice(prefix.length + 1).split(':')) {
      const position = Number.parseInt(token, 36);
      if (position.toString(36) !== token) invalid();
      positions.push(position);
    }
  }
  const canonical = encodePositions(positions);
  if (
    canonical.length !== refs.length ||
    canonical.some((v, i) => v !== refs[i])
  )
    invalid();
  return positions;
}

// Positions refer to the immutable policy content identified by policyVersion.
export function encodeRuleReferences(
  rules: readonly Rule[],
  ids: readonly string[],
): string[] {
  const positions = new Map(rules.map((rule, index) => [rule.id, index]));
  return encodePositions(ids.map((id) => positions.get(id) ?? invalid()));
}

export function decodeRuleReferences(
  rules: readonly Rule[],
  refs: readonly string[],
): string[] {
  return parseRuleReferences(refs).map(
    (position) => rules[position]?.id ?? invalid(),
  );
}
