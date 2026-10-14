import { agentId, validateKeyHash } from './auth.ts';
import type { AgentKeyStore, KeyInsert } from './auth.ts';

export type AgentAuthDatabase = {
  query(sql: string, parameters: unknown[]): Promise<{ rows: unknown[] }>;
};

export class SqlAgentKeyStore implements AgentKeyStore {
  private readonly database: AgentAuthDatabase;
  constructor(database: AgentAuthDatabase) {
    this.database = database;
  }

  async findByHash(keyHash: string): Promise<unknown> {
    validateKeyHash(keyHash);
    try {
      const result = await this.database.query(
        'SELECT k.key_hash AS "keyHash", a.id AS "agentId", a.allowed_tools AS "allowedTools", a.enabled, k.revoked FROM agent_auth.keys k JOIN agent_auth.agents a ON a.id = k.agent_id WHERE k.key_hash = $1',
        [keyHash],
      );
      if (result.rows.length > 1) throw new Error();
      return result.rows[0] ?? null;
    } catch {
      throw new Error('Agent key lookup failed.');
    }
  }

  async insertKey(input: KeyInsert): Promise<void> {
    const hash = validateKeyHash(input.keyHash);
    const id = agentId(input.agentId);
    try {
      await this.database.query(
        'INSERT INTO agent_auth.keys (key_hash, agent_id) VALUES ($1, $2)',
        [hash, id],
      );
    } catch {
      throw new Error('Agent key insertion failed.');
    }
  }
}
