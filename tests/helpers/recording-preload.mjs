// Test-only `node --import` preload for the recording CLI. It appends one line
// to SPENDWALL_TRAP_LOG for every PAYPAL_* environment lookup and every global
// fetch call. Named lookups (get, `in`, Object.hasOwn) and value enumeration
// of present keys (spread, Object.entries) are all recorded. Two exemptions,
// matched on the trap's direct caller only:
// - normalizeSpawnArguments in node:child_process, which copies the
//   environment into a child such as the Docker CLI; the value is passed
//   through, not read by the recording.
// - Object.keys called from a third-party module under node_modules, which
//   lists key names and exposes no value; the `debug` package does this at
//   load to find DEBUG_* names. Object.keys from repository code is recorded,
//   and reading a listed value afterwards goes through `get` and is recorded.
// With SPENDWALL_FAKE_SANDBOX=1, global fetch is served by the synthetic
// payment fixture instead of the network.
import { appendFileSync } from 'node:fs';

const env = process.env;
const log = env.SPENDWALL_TRAP_LOG;
const record = (line) => {
  if (log) appendFileSync(log, line + '\n');
};
let provider = globalThis.fetch;
if (env.SPENDWALL_FAKE_SANDBOX === '1') {
  const { recordedPayments } =
    await import('../../apps/agent-demo/src/payments.ts');
  provider = recordedPayments().fetchImpl;
}
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  record(`fetch ${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
  return provider(input, init);
};
const watched = (key) => typeof key === 'string' && key.startsWith('PAYPAL_');
// Stack frames: "Error", this function, the trap, the trap's direct caller,
// then that caller's caller.
const spawnCopy = () =>
  /^\s*at normalizeSpawnArguments \(node:child_process:/.test(
    new Error().stack.split('\n')[3] ?? '',
  );
const keyListing = () => {
  const stack = new Error().stack.split('\n');
  return (
    /^\s*at Object\.keys \(<anonymous>\)$/.test(stack[3] ?? '') &&
    /\/node_modules\//.test(stack[4] ?? '')
  );
};
process.env = new Proxy(env, {
  get(target, key) {
    if (watched(key) && !spawnCopy()) record(`env ${key}`);
    return Reflect.get(target, key);
  },
  has(target, key) {
    if (watched(key)) record(`env ${key}`);
    return Reflect.has(target, key);
  },
  getOwnPropertyDescriptor(target, key) {
    if (watched(key) && !spawnCopy() && !keyListing()) record(`env ${key}`);
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
