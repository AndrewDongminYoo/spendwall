import type { Pool } from 'pg';
import type { PolicyReplay } from './replay.ts';

// The launcher owns this worker. Nothing is installed outside that process.
export async function startReplayRetention(
  pool: Pick<Pool, 'connect'>,
  replay: PolicyReplay,
) {
  await replay.purge(pool);
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = replay
      .purge(pool)
      .catch(() => {
        console.error(
          'Replay retention cleanup unavailable; inspect the private database configuration.',
        );
      })
      .finally(() => {
        pending = undefined;
      });
  }, 60000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
