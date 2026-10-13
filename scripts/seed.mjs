import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

import { requestSandboxToken } from './check-paypal-sandbox.mjs';

const amounts = [
  '5.00',
  '10.00',
  '20.00',
  '30.00',
  '40.00',
  '80.00',
  '120.00',
  '200.00',
  '350.00',
  '500.00',
  '1.00',
  '1.01',
  '1.02',
  '1.03',
  '1.04',
  '1.05',
  '1.06',
  '1.07',
  '1.08',
  '1.09',
];
const endpoint = 'https://api-m.sandbox.paypal.com/v2/checkout/orders';
const defaultOutput = fileURLToPath(
  new URL('../fixtures/captures.json', import.meta.url),
);
const replayWindow = 5 * 60 * 60 * 1000;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const timestamp = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const customerId = (batchId, index) =>
  `seed-${batchId}-${index < 10 ? index + 1 : 'velocity'}`;

function requestBody(batch, entry) {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        custom_id: entry.customerId,
        amount: { currency_code: 'USD', value: entry.amount },
      },
    ],
    payment_source: {
      card: {
        // Published PayPal sandbox-only test card; never accept a real card input.
        number: '4012888888881881',
        expiry: batch.expiry,
        security_code: '123',
        name: 'Spendwall Sandbox',
        billing_address: {
          address_line_1: '123 Test Street',
          admin_area_2: 'San Jose',
          admin_area_1: 'CA',
          postal_code: '95131',
          country_code: 'US',
        },
      },
    },
  };
}

function validateState(state, clientIdHash) {
  const invalid = () => {
    throw new Error(
      'Invalid seed fixture; preserve it and investigate before retrying.',
    );
  };
  if (
    state?.schemaVersion !== 1 ||
    state.environment !== 'sandbox' ||
    !Array.isArray(state.captures) ||
    !/^[a-f0-9]{64}$/.test(state.clientIdHash)
  )
    invalid();
  if (state.clientIdHash !== clientIdHash)
    throw new Error(
      'Fixture belongs to a different sandbox app; use a separate output path.',
    );
  for (const field of ['id', 'orderId', 'requestId']) {
    if (
      new Set(state.captures.map((capture) => capture?.[field])).size !==
      state.captures.length
    )
      invalid();
  }
  for (const capture of state.captures) {
    if (
      !identifier(capture?.id) ||
      !identifier(capture.orderId) ||
      !uuid.test(capture.requestId) ||
      !uuid.test(capture.batchId) ||
      !amounts.includes(capture.amount) ||
      capture.currency !== 'USD' ||
      typeof capture.customerId !== 'string' ||
      !capture.customerId.startsWith(`seed-${capture.batchId}-`) ||
      !timestamp(capture.createdAt)
    )
      invalid();
  }
  if (state.pending === null) return;
  const batch = state.pending;
  if (
    !uuid.test(batch?.id) ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(batch.expiry) ||
    !Array.isArray(batch.entries) ||
    batch.entries.length !== amounts.length ||
    new Set(batch.entries.map((entry) => entry?.requestId)).size !==
      amounts.length
  )
    invalid();
  for (const [index, entry] of batch.entries.entries()) {
    if (
      !uuid.test(entry?.requestId) ||
      entry.amount !== amounts[index] ||
      entry.customerId !== customerId(batch.id, index) ||
      (entry.startedAt !== null && !timestamp(entry.startedAt))
    )
      invalid();
    if (
      entry.startedAt !== null &&
      entry.bodyHash !== hash(JSON.stringify(requestBody(batch, entry)))
    )
      invalid();
    const captured = state.captures.find(
      (capture) => capture.requestId === entry.requestId,
    );
    if (
      captured &&
      (entry.startedAt === null ||
        captured.batchId !== batch.id ||
        captured.amount !== entry.amount ||
        captured.customerId !== entry.customerId)
    )
      invalid();
  }
}

function checkReplay(entry, now) {
  if (entry.startedAt === null) return;
  const age = now.getTime() - Date.parse(entry.startedAt);
  if (age < 0 || age >= replayWindow)
    throw new Error(
      'Pending request needs manual reconciliation; its safe replay window has expired or the clock changed.',
    );
}

async function saveState(output, state) {
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      await format(JSON.stringify(state), { parser: 'json' }),
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createCapture({
  batch,
  entry,
  token,
  fetchImpl,
  timeoutMs,
  sleep,
  now,
}) {
  const body = JSON.stringify(requestBody(batch, entry));
  for (let attempt = 0; attempt < 3; attempt++) {
    checkReplay(entry, now());
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          'PayPal-Request-Id': entry.requestId,
        },
        body,
      });
    } catch {
      if (attempt === 2)
        throw new Error(
          'Sandbox capture request failed or timed out; pending request was retained.',
        );
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new Error(
        `Sandbox capture failed (HTTP ${response.status}); check sandbox credentials, card eligibility, and pending request state.`,
      );
    }
    let order;
    try {
      order = await response.json();
    } catch {
      throw new Error(
        'Sandbox capture response is invalid; pending request was retained.',
      );
    }
    const unit = order?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (
      order?.status !== 'COMPLETED' ||
      !identifier(order.id) ||
      !Array.isArray(order.purchase_units) ||
      order.purchase_units.length !== 1 ||
      unit?.custom_id !== entry.customerId ||
      !Array.isArray(unit.payments?.captures) ||
      unit.payments.captures.length !== 1 ||
      capture?.status !== 'COMPLETED' ||
      !identifier(capture.id) ||
      capture.amount?.currency_code !== 'USD' ||
      capture.amount.value !== entry.amount
    )
      throw new Error(
        'Sandbox response did not contain a valid completed capture; reconcile the pending request.',
      );
    return {
      id: capture.id,
      orderId: order.id,
      amount: entry.amount,
      currency: 'USD',
      customerId: entry.customerId,
      batchId: batch.id,
      requestId: entry.requestId,
      createdAt: now().toISOString(),
    };
  }
}

export async function seedSandbox({
  output = defaultOutput,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  sleep = delay,
  now = () => new Date(),
  onCapture = () => {},
} = {}) {
  if (!env.PAYPAL_CLIENT_ID?.trim() || !env.PAYPAL_CLIENT_SECRET?.trim())
    throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET locally.');
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  const lockPath = `${output}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Seed fixture is locked; check the existing process before removing a stale lock.',
      );
    throw new Error(
      'Cannot lock seed fixture; check output-directory permissions.',
    );
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }),
    );
    const clientIdHash = hash(env.PAYPAL_CLIENT_ID);
    let state;
    try {
      state = JSON.parse(await readFile(output, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          'Cannot read seed fixture; preserve it and investigate.',
        );
      state = {
        schemaVersion: 1,
        environment: 'sandbox',
        clientIdHash,
        captures: [],
        pending: null,
      };
    }
    validateState(state, clientIdHash);
    const previousCount = state.captures.length;
    if (state.pending) {
      for (const entry of state.pending.entries) {
        if (
          !state.captures.some(
            (capture) => capture.requestId === entry.requestId,
          )
        )
          checkReplay(entry, now());
      }
    }
    const token = await requestSandboxToken({ env, fetchImpl });
    if (!state.pending) {
      const id = randomUUID();
      state.pending = {
        id,
        expiry: `${now().getUTCFullYear() + 3}-12`,
        entries: amounts.map((amount, index) => ({
          requestId: randomUUID(),
          amount,
          customerId: customerId(id, index),
          startedAt: null,
          bodyHash: null,
        })),
      };
    }
    const batch = state.pending;
    for (const entry of batch.entries) {
      if (
        state.captures.some((capture) => capture.requestId === entry.requestId)
      )
        continue;
      if (entry.startedAt === null) {
        entry.startedAt = now().toISOString();
        entry.bodyHash = hash(JSON.stringify(requestBody(batch, entry)));
      }
      await saveState(output, state);
      const capture = await createCapture({
        batch,
        entry,
        token: token.access_token,
        fetchImpl,
        timeoutMs,
        sleep,
        now,
      });
      if (
        state.captures.some(
          (existing) =>
            existing.id === capture.id || existing.orderId === capture.orderId,
        )
      )
        throw new Error(
          'Duplicate capture or order ID; pending request retained for reconciliation.',
        );
      state.captures.push(capture);
      await saveState(output, state);
      onCapture(state.captures.length - previousCount);
    }
    state.pending = null;
    await saveState(output, state);
    return {
      environment: 'sandbox',
      batchId: batch.id,
      added: state.captures.length - previousCount,
      total: state.captures.length,
    };
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 0 &&
      (args.length !== 2 || args[0] !== '--output' || !args[1])
    )
      throw new Error('Usage: pnpm seed [--output <fixture-path>]');
    const result = await seedSandbox({
      output: args[1] ?? defaultOutput,
      onCapture: (count) => console.log(`Recorded sandbox capture ${count}.`),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
