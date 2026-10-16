import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AgentAuthentication, AgentPrincipal } from './server.ts';
import { identifier } from './context/json.ts';

type Database = Pick<Pool, 'query'>;
const keyPattern = /^sw_agent_[A-Za-z0-9_-]{43}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function grants(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128)
    throw new Error('Invalid agent grant.');
  const tools = value.map((tool) => identifier(tool));
  if (new Set(tools).size !== tools.length)
    throw new Error('Invalid agent grant.');
  return tools;
}
function digest(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

export async function issueAgentKey(
  pool: Database,
  merchant: string,
  agent: string,
  tools: string[],
) {
  const merchantId = identifier(merchant),
    agentId = identifier(agent),
    allowed = grants(tools);
  const key = 'sw_agent_' + randomBytes(32).toString('base64url'),
    id = randomUUID();
  await pool.query({
    text: 'INSERT INTO agent_auth.credentials(id,merchant_id,agent_id,key_hash,tools) VALUES($1,$2,$3,$4,$5)',
    values: [id, merchantId, agentId, digest(key), allowed],
  });
  return { id, key };
}
export async function revokeAgentKey(
  pool: Database,
  merchant: string,
  id: string,
) {
  identifier(merchant);
  if (!uuid.test(id)) throw new Error('Invalid credential ID.');
  const result = await pool.query({
    text: 'UPDATE agent_auth.credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE merchant_id=$1 AND id=$2 RETURNING id',
    values: [merchant, id],
  });
  return result.rows.length === 1;
}
export class AgentAuthority implements AgentAuthentication {
  private readonly pool: Database;
  private readonly merchant: string;
  constructor(pool: Database, merchant: string) {
    this.pool = pool;
    this.merchant = identifier(merchant);
  }
  async authenticate(token: string): Promise<AgentPrincipal | null> {
    if (typeof token !== 'string' || !keyPattern.test(token)) return null;
    const result = await this.pool.query({
      text: 'SELECT agent_id,tools FROM agent_auth.credentials WHERE key_hash=$1 AND merchant_id=$2 AND revoked_at IS NULL',
      values: [digest(token), this.merchant],
    });
    if (result.rows.length !== 1) return null;
    const row = result.rows[0];
    return Object.freeze({
      merchantId: this.merchant,
      agentId: identifier(row.agent_id),
      tools: Object.freeze(grants(row.tools)),
    });
  }
}
