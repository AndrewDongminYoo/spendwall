import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type AgentPrincipal = {
  readonly agentId: string;
  readonly allowedTools: readonly string[];
};
export type AgentKeyRecord = {
  keyHash: string;
  agentId: string;
  allowedTools: string[];
  enabled: boolean;
  revoked: boolean;
};
export type KeyInsert = { agentId: string; keyHash: string };
export interface AgentKeyStore {
  findByHash(keyHash: string): Promise<unknown>;
  insertKey(input: KeyInsert): Promise<void>;
}

export function agentId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    throw new Error('Invalid agent identity.');
  return value;
}

export function validateKeyHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Invalid agent key hash.');
  return value;
}

export function hashAgentKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value))
    throw new Error('Invalid agent key.');
  return createHash('sha256').update(value).digest('hex');
}

export async function issueAgentKey(
  store: Pick<AgentKeyStore, 'insertKey'>,
  id: string,
): Promise<string> {
  try {
    agentId(id);
    const key = `sw_agent_${randomBytes(32).toString('hex')}`;
    await store.insertKey({ agentId: id, keyHash: hashAgentKey(key) });
    return key;
  } catch {
    throw new Error('Agent key issuance failed.');
  }
}

function principal(value: unknown, expectedHash: string): AgentPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = ['keyHash', 'agentId', 'allowedTools', 'enabled', 'revoked'];
  if (
    Reflect.ownKeys(value).length !== names.length ||
    names.some((name) => !descriptors[name] || !('value' in descriptors[name]!))
  )
    throw new Error();
  const row = value as AgentKeyRecord;
  const storedHash = validateKeyHash(row.keyHash);
  if (
    !timingSafeEqual(Buffer.from(storedHash), Buffer.from(expectedHash)) ||
    row.enabled !== true ||
    row.revoked !== false
  )
    throw new Error();
  const id = agentId(row.agentId);
  if (!Array.isArray(row.allowedTools) || row.allowedTools.length > 256)
    throw new Error();
  const tools: string[] = [];
  for (let index = 0; index < row.allowedTools.length; index++) {
    const item = Object.getOwnPropertyDescriptor(
      row.allowedTools,
      String(index),
    );
    if (
      !item ||
      !('value' in item) ||
      typeof item.value !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(item.value) ||
      tools.includes(item.value)
    )
      throw new Error();
    tools.push(item.value);
  }
  return Object.freeze({ agentId: id, allowedTools: Object.freeze(tools) });
}

export async function authenticateAgent(
  store: Pick<AgentKeyStore, 'findByHash'>,
  authorization: string | undefined,
  timeoutMs = 5000,
): Promise<AgentPrincipal | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      return null;
    if (
      typeof authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization)
    )
      return null;
    const hash = hashAgentKey(authorization.slice(7));
    const row = await Promise.race([
      store.findByHash(hash),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error()), timeoutMs);
      }),
    ]);
    return principal(row, hash);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
