-- Owner-reviewed standalone schema; this change does not apply a migration.
BEGIN;
CREATE SCHEMA agent_auth;
REVOKE ALL ON SCHEMA agent_auth FROM PUBLIC;
CREATE TABLE agent_auth.agents (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'
    AND id NOT IN ('__proto__', 'constructor', 'prototype')),
  allowed_tools text[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(allowed_tools) <= 256 AND array_position(allowed_tools, NULL) IS NULL),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE agent_auth.keys (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  agent_id text NOT NULL REFERENCES agent_auth.agents(id),
  revoked boolean NOT NULL DEFAULT false
);
REVOKE ALL ON agent_auth.agents, agent_auth.keys FROM PUBLIC;
COMMIT;
