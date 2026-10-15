import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Only this function creates a database target. No environment URL is accepted.
export async function withDemoDatabase<T>(
  run: (url: string) => Promise<T>,
  signal?: AbortSignal,
) {
  const name = `spendwall-demo-${randomUUID()}`;
  function docker(...args: string[]) {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0)
      throw new Error(
        `Demo Docker ${args[0]} failed. Start Docker with postgres:17-alpine available.`,
      );
    return result.stdout.trim();
  }
  let started = false;
  try {
    signal?.throwIfAborted();
    docker(
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '--label',
      `spendwall.demo.pid=${process.pid}`,
      '-e',
      'POSTGRES_USER=demo_owner',
      '-e',
      'POSTGRES_PASSWORD=synthetic-demo-only',
      '-e',
      'POSTGRES_DB=spendwall_demo',
      '-p',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    );
    started = true;
    const port = docker('port', name, '5432/tcp').split(':').at(-1);
    const url = `postgresql://demo_owner:synthetic-demo-only@127.0.0.1:${port}/spendwall_demo`;
    const pool = new pg.Pool({
      connectionString: url,
      connectionTimeoutMillis: 1000,
    });
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        signal?.throwIfAborted();
        try {
          await pool.query('SELECT 1');
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!ready) throw new Error('Demo database did not become ready.');
    } finally {
      await pool.end();
    }
    signal?.throwIfAborted();
    const result = await run(url);
    signal?.throwIfAborted();
    return result;
  } finally {
    if (started) docker('rm', '-f', name);
  }
}
