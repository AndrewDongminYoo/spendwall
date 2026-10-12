import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'trunk',
  [
    'exec',
    '--',
    'gitleaks',
    'git',
    '--staged',
    '--redact',
    '--no-banner',
    '--no-color',
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(
    'Secret check could not start. Install Trunk before committing.',
  );
}
process.exit(result.status ?? 1);
