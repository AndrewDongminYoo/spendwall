import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FcmSender } from '../../firewall/src/approver/fcm.ts';
import type { DeviceGrant } from '../../firewall/src/approver/identity.ts';
import { withDemoDatabase } from './database.ts';
import { createRecordingDemo } from './recording.ts';

const args = process.argv.slice(2);
if (
  !args[0] ||
  !isAbsolute(args[0]) ||
  (args.length !== 1 && (args.length !== 3 || args[1] !== '--fcm' || !args[2]))
) {
  console.error(
    'Usage: pnpm demo:recording /absolute/private/config.json [--fcm project-id]',
  );
  process.exitCode = 2;
} else {
  const configFile = args[0];
  const readConfig = () => {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      Object.keys(config).some(
        (key) =>
          !['identityKey', 'signingKey', 'devices', 'port'].includes(key),
      ) ||
      typeof config.identityKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(config.identityKey) ||
      typeof config.signingKey !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(config.signingKey) ||
      !Array.isArray(config.devices) ||
      (config.port !== undefined &&
        (!Number.isInteger(config.port) ||
          config.port < 0 ||
          config.port > 65535))
    )
      throw new Error('Recording configuration unavailable.');
    return config as {
      identityKey: string;
      signingKey: string;
      devices: DeviceGrant[];
      port?: number;
    };
  };
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
    const notifier =
      args[1] === '--fcm' ? new FcmSender({ projectId: args[2]! }) : undefined;
    console.log(
      'HUMAN APPROVAL RECORDING / SYNTHETIC PAYMENTS / NO LIVE PAYPAL OR AI',
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
      });
      try {
        console.log(`Approval API: ${demo.url}`);
        console.log(
          'Waiting for a registered demo-support approver before creating the synthetic USD 60.00 request.',
        );
        while (!(await demo.ready()))
          await delay(250, undefined, { signal: cancellation.signal });
        cancellation.signal.throwIfAborted();
        const pending = await demo.request();
        if (!('status' in pending) || pending.status !== 'pending_approval')
          throw new Error('Recording policy did not require approval.');
        console.log(
          `pending_approval: ${pending.approval_id}; synthetic executions=${demo.payments.length}`,
        );
        for (;;) {
          cancellation.signal.throwIfAborted();
          const status = await demo.status(pending.approval_id);
          if (
            status.status !== 'pending' &&
            status.execution_state !== 'in_flight'
          ) {
            console.log(
              `SYNTHETIC REFUND RESULT: ${JSON.stringify(status)}; synthetic executions=${demo.payments.length}`,
            );
            const succeeded = status.execution_state === 'succeeded';
            if (
              (succeeded && demo.payments.length !== 1) ||
              (['denied', 'expired'].includes(status.status) &&
                demo.payments.length !== 0)
            )
              throw new Error('Unexpected synthetic execution count.');
            if (!succeeded) process.exitCode = 1;
            console.log(
              'Result remains available until Ctrl+C. Keep the SYNTHETIC PAYMENTS label visible while recording.',
            );
            // The mobile client fetches detail after POST /decision and may
            // refresh again while filming. Keep its status endpoint available.
            for (;;)
              await delay(1000, undefined, { signal: cancellation.signal });
          }
          await delay(250, undefined, { signal: cancellation.signal });
        }
      } finally {
        await demo.close();
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
