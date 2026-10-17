import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { withDemoDatabase } from './database.ts';
import { createDemo, readTicket, scenarios } from './firewall.ts';
import type { Scenario } from './firewall.ts';
import { replay, reviewPending } from './runner.ts';
import { runLive } from './agent.ts';
import {
  createShoppingDemo,
  readShoppingTicket,
  replayShopping,
} from './shopping.ts';

const args = process.argv.slice(2);
const name = args[0] ?? 'all';
const live = args[1] === '--live';
if (
  args.length > 2 ||
  (args[1] !== undefined && !live) ||
  (name !== 'all' && !scenarios.includes(name as Scenario)) ||
  (live && name === 'all')
) {
  console.error(
    'Usage: pnpm demo [all|small|approval|injection|velocity|shopping] [--live]',
  );
  process.exitCode = 2;
} else if (live && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    'Live mode requires ANTHROPIC_API_KEY. Payment responses remain synthetic.',
  );
  process.exitCode = 2;
} else {
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
  const color = stdout.isTTY && !Object.hasOwn(process.env, 'NO_COLOR');
  const print = (decision: string, reason: string) => {
    // Red: deny. Yellow: waiting on a human. Magenta: an unknown money outcome
    // that needs recovery and must never read as success.
    const code =
      decision === 'deny'
        ? 31
        : decision === 'pending_approval'
          ? 33
          : decision === 'unknown'
            ? 35
            : 32;
    console.log(
      `${color ? `\x1b[${code}m` : ''}${decision}${color ? '\x1b[0m' : ''}: ${reason}`,
    );
  };
  try {
    console.log(
      live
        ? 'LIVE CLAUDE / SYNTHETIC PAYMENTS'
        : 'RECORDED AGENT CALLS / SYNTHETIC PAYMENTS / SCRIPTED HUMAN APPROVAL',
    );
    await withDemoDatabase(async (url) => {
      for (const scenario of name === 'all' ? scenarios : [name as Scenario]) {
        cancellation.signal.throwIfAborted();
        if (scenario === 'shopping') {
          const demo = await createShoppingDemo(
            url,
            await readShoppingTicket(),
            (event) => print(event.decision, event.reason),
          );
          try {
            cancellation.signal.throwIfAborted();
            console.log(`\nTicket: ${scenario}`);
            if (live) {
              await runLive(
                demo,
                process.env.ANTHROPIC_API_KEY!,
                (text) => console.log(text),
                undefined,
                cancellation.signal,
              );
              for (const id of demo.createdOrders())
                console.log(
                  `Order ${id}: ${demo.orderStatus(id)}; buyer approval and capture are exercised by the recorded replay.`,
                );
              console.log(
                `${scenario}: LIVE OBSERVATION payments=${demo.payments.length}`,
              );
            } else {
              await replayShopping(demo, cancellation.signal);
              console.log(`${scenario}: PASS payments=${demo.payments.length}`);
            }
          } finally {
            await demo.close();
          }
          continue;
        }
        const demo = await createDemo(
          url,
          await readTicket(scenario),
          (event) => print(event.decision, event.reason),
        );
        try {
          cancellation.signal.throwIfAborted();
          console.log(`\nTicket: ${scenario}`);
          if (live) {
            await runLive(
              demo,
              process.env.ANTHROPIC_API_KEY!,
              (text) => console.log(text),
              undefined,
              cancellation.signal,
            );
            await reviewPending(
              demo,
              async (prompt) => {
                if (!stdin.isTTY) return false;
                const terminal = createInterface({
                  input: stdin,
                  output: stdout,
                });
                try {
                  return (
                    (await terminal.question(prompt, {
                      signal: cancellation.signal,
                    })) === 'approve'
                  );
                } finally {
                  terminal.close();
                }
              },
              cancellation.signal,
            );
            console.log(
              `${scenario}: LIVE OBSERVATION payments=${demo.payments.length}`,
            );
          } else {
            await replay(demo, cancellation.signal);
            console.log(`${scenario}: PASS payments=${demo.payments.length}`);
          }
        } finally {
          await demo.close();
        }
      }
    }, cancellation.signal);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Demo failed.');
    process.exitCode = interrupted || 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}
