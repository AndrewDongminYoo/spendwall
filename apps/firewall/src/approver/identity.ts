import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { ApprovalKeys, approvalId } from '../approvals/binding.ts';
import { identifier, object, snapshot } from '../context/json.ts';

export type DeviceGrant = Readonly<{
  deviceId: string;
  agentId: string;
  enrollmentHash: string;
}>;
export type ApproverPrincipal = Readonly<{
  deviceRef: string;
  agentId: string;
  generation: number;
  ownerRef: string;
  expiresAt: number;
}>;
type Options = {
  identityKey: string;
  signingKey: string;
  merchantId: string;
  devices: () => readonly DeviceGrant[];
  now?: () => number;
};
type DeviceRow = {
  device_ref: string;
  owner_ref: string;
  generation: number;
  active: boolean;
  token_sealed: string;
};
export class ApproverAuthError extends Error {
  constructor() {
    super('Approver authentication required.');
    this.name = 'ApproverAuthError';
  }
}
function denied(): never {
  throw new ApproverAuthError();
}
export function deliveryToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    denied();
  return value;
}
export class DeviceAuthority {
  private readonly pool: Pick<Pool, 'connect'>;
  private readonly options: Options;
  private readonly keys: ApprovalKeys;
  private readonly secret: Uint8Array;
  private readonly merchant: string;
  private readonly audience: string;
  constructor(pool: Pick<Pool, 'connect'>, options: Options) {
    this.pool = pool;
    this.options = options;
    this.keys = new ApprovalKeys(options.identityKey);
    this.merchant = identifier(options.merchantId);
    if (
      !/^[a-f0-9]{64}$/i.test(options.signingKey) ||
      options.signingKey.toLowerCase() === options.identityKey.toLowerCase()
    )
      denied();
    this.secret = Buffer.from(options.signingKey, 'hex');
    this.audience =
      'spendwall:approvals:' + this.keys.reference('merchant', this.merchant);
    this.grants();
  }
  private grants(): DeviceGrant[] {
    const values = snapshot(this.options.devices());
    if (!Array.isArray(values) || values.length > 64) denied();
    const ids = new Set(),
      hashes = new Set();
    return values.map((input) => {
      const item = object(input);
      if (
        Object.keys(item).length !== 3 ||
        typeof item.enrollmentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.enrollmentHash)
      )
        denied();
      const deviceId = identifier(item.deviceId),
        agentId = identifier(item.agentId);
      if (ids.has(deviceId) || hashes.has(item.enrollmentHash)) denied();
      ids.add(deviceId);
      hashes.add(item.enrollmentHash);
      return { deviceId, agentId, enrollmentHash: item.enrollmentHash };
    });
  }
  private time() {
    const value = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) denied();
    return value;
  }
  deviceRef(id: string) {
    return this.keys.reference('approver-device', [
      this.merchant,
      identifier(id),
    ]);
  }
  ownerRef(agent: string) {
    return this.keys.reference('owner', [this.merchant, identifier(agent)]);
  }
  merchantRef() {
    return this.keys.reference('merchant', this.merchant);
  }
  private aad(ref: string, owner: string, generation: number) {
    return `approver-device.v1:${ref}:${owner}:${generation}`;
  }
  async enroll(deviceId: string, token: unknown, credential: string) {
    identifier(deviceId);
    const fcmToken = deliveryToken(token);
    if (
      typeof credential !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(credential)
    )
      denied();
    const digest = createHash('sha256').update(credential).digest('hex');
    const current = () => {
      const grant = this.grants().find((g) => g.deviceId === deviceId);
      if (
        !grant ||
        !timingSafeEqual(
          Buffer.from(digest, 'hex'),
          Buffer.from(grant.enrollmentHash, 'hex'),
        )
      )
        denied();
      return grant;
    };
    current();
    const ref = this.deviceRef(deviceId),
      client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`spendwall/approver-device/v1/${ref}`],
      );
      const grant = current(),
        owner = this.ownerRef(grant.agentId);
      const previous = (
        await client.query<DeviceRow>(
          'SELECT * FROM approvals.devices WHERE device_ref=$1 FOR UPDATE',
          [ref],
        )
      ).rows[0];
      if (previous && previous.owner_ref !== owner) denied();
      const generation = (previous?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation) || generation > 2147483647)
        denied();
      const sealed = this.keys.seal(
        { token: fcmToken },
        this.aad(ref, owner, generation),
      );
      await client.query(
        `INSERT INTO approvals.devices(device_ref,owner_ref,generation,token_sealed) VALUES($1,$2,$3,$4)
        ON CONFLICT(device_ref) DO UPDATE SET generation=excluded.generation,token_sealed=excluded.token_sealed,active=true`,
        [ref, owner, generation, sealed],
      );
      const used = await client.query(
        'INSERT INTO approvals.used_enrollments(enrollment_hash,device_ref) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING enrollment_hash',
        [digest, ref],
      );
      if (used.rows.length !== 1) denied();
      const now = Math.floor(this.time() / 1000);
      const jwt = await new SignJWT({ generation })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('spendwall:approvers')
        .setAudience(this.audience)
        .setSubject(ref)
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 900)
        .setJti(randomUUID())
        .sign(this.secret);
      await client.query('COMMIT');
      inTransaction = false;
      return { access_token: jwt, token_type: 'Bearer', expires_in: 900 };
    } finally {
      await this.release(client, inTransaction);
    }
  }
  private async release(client: PoolClient, inTransaction: boolean) {
    let broken = false;
    if (inTransaction)
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
    client.release(broken);
  }
  private grantFor(ref: string) {
    return this.grants().find((g) => this.deviceRef(g.deviceId) === ref);
  }
  async authenticate(token: string): Promise<ApproverPrincipal> {
    let payload;
    try {
      if (typeof token !== 'string' || token.length > 4096) denied();
      ({ payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: 'spendwall:approvers',
        audience: this.audience,
        typ: 'JWT',
        requiredClaims: ['sub', 'exp', 'iat', 'nbf', 'jti', 'generation'],
        maxTokenAge: 900,
        currentDate: new Date(this.time()),
      }));
      if (
        typeof payload.sub !== 'string' ||
        !/^[a-f0-9]{64}$/.test(payload.sub) ||
        !Number.isSafeInteger(payload.generation) ||
        Number(payload.generation) < 1 ||
        typeof payload.iat !== 'number' ||
        payload.exp !== payload.iat + 900 ||
        payload.nbf !== payload.iat ||
        payload.aud !== this.audience
      )
        denied();
      approvalId(payload.jti);
    } catch {
      return denied();
    }
    const grant = this.grantFor(payload.sub);
    if (!grant) denied();
    const client = await this.pool.connect();
    try {
      const row = (
        await client.query<DeviceRow>(
          'SELECT * FROM approvals.devices WHERE device_ref=$1',
          [payload.sub],
        )
      ).rows[0];
      if (
        !row ||
        !row.active ||
        row.generation !== payload.generation ||
        row.owner_ref !== this.ownerRef(grant.agentId)
      )
        denied();
      return Object.freeze({
        deviceRef: row.device_ref,
        agentId: grant.agentId,
        generation: row.generation,
        ownerRef: row.owner_ref,
        expiresAt: Number(payload.exp) * 1000,
      });
    } finally {
      client.release();
    }
  }
  async authorize(
    client: PoolClient,
    principal: ApproverPrincipal,
  ): Promise<boolean> {
    const grant = this.grantFor(principal.deviceRef);
    if (
      !grant ||
      grant.agentId !== principal.agentId ||
      this.time() >= principal.expiresAt
    )
      return false;
    const row = (
      await client.query<DeviceRow>(
        'SELECT * FROM approvals.devices WHERE device_ref=$1 FOR SHARE',
        [principal.deviceRef],
      )
    ).rows[0];
    const current = this.grantFor(principal.deviceRef);
    return (
      !!current &&
      current.agentId === principal.agentId &&
      this.time() < principal.expiresAt &&
      !!row &&
      row.active &&
      row.generation === principal.generation &&
      row.owner_ref === principal.ownerRef &&
      row.owner_ref === this.ownerRef(current.agentId)
    );
  }
  async deliveryDevice(ref: string, generation: number) {
    const grant = this.grantFor(ref);
    if (!grant) return null;
    const client = await this.pool.connect();
    try {
      const row = (
        await client.query<DeviceRow>(
          'SELECT * FROM approvals.devices WHERE device_ref=$1',
          [ref],
        )
      ).rows[0];
      if (
        !row ||
        !row.active ||
        row.generation !== generation ||
        row.owner_ref !== this.ownerRef(grant.agentId)
      )
        return null;
      return {
        token: deliveryToken(
          object(
            this.keys.open(
              row.token_sealed,
              this.aad(ref, row.owner_ref, generation),
            ),
          ).token,
        ),
        ownerRef: row.owner_ref,
      };
    } finally {
      client.release();
    }
  }
}
