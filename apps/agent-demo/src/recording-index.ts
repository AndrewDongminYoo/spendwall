import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FcmSender } from '../../firewall/src/approver/fcm.ts';
import { startApproverForwarder } from '../../firewall/src/approver/forwarder.ts';
import { withDemoDatabase } from './database.ts';
import { createRecordingDemo, sandboxResultLine } from './recording.ts';
import { readForwardTls, readRecordingConfig } from './recording-config.ts';

// Each option at most once, in either order; anything else is a usage error.
function parseArgs(args: string[]) {
  const [configFile, ...rest] = args;
  if (!configFile || !isAbsolute(configFile)) return undefined;
  let fcm: string | undefined;
  let sandbox = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const next = rest[index + 1];
    if (arg === '--paypal-sandbox' && !sandbox) sandbox = true;
    else if (
      arg === '--fcm' &&
      fcm === undefined &&
      next &&
      !next.startsWith('--')
    )
      fcm = rest[++index];
    else return undefined;
  }
  return { configFile, fcm, sandbox };
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.error(
    'Usage: pnpm demo:recording /absolute/private/config.json [--fcm project-id] [--paypal-sandbox]',
  );
  process.exitCode = 2;
} else {
  const { configFile } = args;
  const readConfig = () => readRecordingConfig(configFile);
  const cancellation = new AbortController();
  let interrupted = 0;
  const onInterrupt = () => {
    interrupted = 130;
    cancellation.abort();
  };
  const onTerminate = () => {
    interrupted = 143;
    cancellation.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const config = readConfig();
    // Read once at startup so a missing or unsafe key fails before Docker.
    const tls = config.forward ? readForwardTls(config.forward) : undefined;
    // The flag and the sandbox object must agree, and sandbox credentials must
    // be present, before Docker starts. Only this branch reads PayPal env.
    if (args.sandbox !== Boolean(config.sandbox)) throw new Error();
    const paypal =
      args.sandbox && config.sandbox
        ? { sandbox: config.sandbox, fetchImpl: fetch, env: process.env }
        : undefined;
    if (
      paypal &&
      (!paypal.env.PAYPAL_CLIENT_ID?.trim() ||
        !paypal.env.PAYPAL_CLIENT_SECRET?.trim())
    )
      throw new Error();
    const notifier = args.fcm
      ? new FcmSender({ projectId: args.fcm })
      : undefined;
    console.log(
      paypal
        ? 'HUMAN APPROVAL RECORDING / PAYPAL SANDBOX REFUND / NO LIVE PAYPAL OR AI'
        : 'HUMAN APPROVAL RECORDING / SYNTHETIC PAYMENTS / NO LIVE PAYPAL OR AI',
    );
    console.log(
      notifier
        ? 'FCM EXPLICITLY ENABLED; physical delivery remains an operator check.'
        : 'NOTIFICATIONS DISABLED; local API rehearsal only.',
    );
    await withDemoDatabase(async (url) => {
      const demo = await createRecordingDemo(url, {
        identityKey: config.identityKey,
        signingKey: config.signingKey,
        // Allows separately provisioned replacement digests without logging or
        // issuing enrollment credentials. Keys remain fixed for this run.
        devices: () => readConfig().devices,
        ...(config.port === undefined ? {} : { port: config.port }),
        ...(notifier ? { notifier } : {}),
        ...(paypal ? { paypal } : {}),
      });
      let forwarder:
        Awaited<ReturnType<typeof startApproverForwarder>> | undefined;
      try {
        console.log(`Approval API: ${demo.url}`);
        if (config.forward && tls) {
          forwarder = await startApproverForwarder({
            bind: config.forward.bind,
            port: config.forward.port,
            host: config.forward.host,
            cert: tls.cert,
            key: tls.key,
            apiUrl: demo.url,
          });
          console.log(`Tailnet HTTPS forwarder: ${forwarder.origin}`);
        }
        console.log(
          paypal
            ? 'Waiting for a registered demo-support approver before creating the PayPal sandbox refund request.'
            : 'Waiting for a registered demo-support approver before creating the synthetic USD 60.00 request.',
        );
        while (!(await demo.ready()))
          await delay(250, undefined, { signal: cancellation.signal });
        cancellation.signal.throwIfAborted();
        const pending = await demo.request();
        if (!('status' in pending) || pending.status !== 'pending_approval') {
          if (!paypal)
            throw new Error('Recording policy did not require approval.');
          // An allowed or denied request reserves nothing for approval and
          // submits no refund. The message names no payment fact.
          console.error(
            'Recording policy did not require approval; no sandbox refund was created.',
          );
          process.exitCode = 1;
          return;
        }
        console.log(
          paypal
            ? `pending_approval: ${pending.approval_id}; sandbox refund submissions=${demo.executions()}`
            : `pending_approval: ${pending.approval_id}; synthetic executions=${demo.executions()}`,
        );
        for (;;) {
          cancellation.signal.throwIfAborted();
          const status = await demo.status(pending.approval_id);
          if (
            status.status !== 'pending' &&
            status.execution_state !== 'in_flight'
          ) {
            const executions = demo.executions();
            console.log(
              paypal
                ? sandboxResultLine(status, executions)
                : `SYNTHETIC REFUND RESULT: ${JSON.stringify(status)}; synthetic executions=${executions}`,
            );
            const succeeded = status.execution_state === 'succeeded';
            if (
              (succeeded && executions !== 1) ||
              (['denied', 'expired'].includes(status.status) &&
                executions !== 0)
            )
              throw new Error('Unexpected recording execution count.');
            if (!succeeded) process.exitCode = 1;
            console.log(
              paypal
                ? 'Result remains available until Ctrl+C. Keep the PAYPAL SANDBOX REFUND label visible while recording.'
                : 'Result remains available until Ctrl+C. Keep the SYNTHETIC PAYMENTS label visible while recording.',
            );
            // The mobile client fetches detail after POST /decision and may
            // refresh again while filming. Keep its status endpoint available.
            for (;;)
              await delay(1000, undefined, { signal: cancellation.signal });
          }
          await delay(250, undefined, { signal: cancellation.signal });
        }
      } finally {
        try {
          await forwarder?.close();
        } finally {
          await demo.close();
        }
      }
    }, cancellation.signal);
  } catch {
    // Never print configuration, provider errors, JWTs or enrollment material.
    console.error(
      interrupted
        ? 'Recording interrupted; local resources closed.'
        : 'Recording unavailable. Check the private config, Docker and local port; see docs/recording-approval.md.',
    );
    process.exitCode = interrupted || 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
