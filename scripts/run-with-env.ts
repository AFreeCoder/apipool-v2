#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const separator = process.argv.indexOf('--');

if (separator === -1) {
  console.error(
    'Usage: tsx scripts/run-with-env.ts KEY=value [KEY=value ...] -- <command> [args...]'
  );
  process.exit(1);
}

const envArgs = process.argv.slice(2, separator);
const commandArgs = process.argv.slice(separator + 1);

if (commandArgs.length === 0) {
  console.error('No command provided');
  process.exit(1);
}

const env = { ...process.env };

for (const pair of envArgs) {
  const equalsIndex = pair.indexOf('=');
  if (equalsIndex <= 0) {
    console.error(`Invalid env assignment: ${pair}`);
    process.exit(1);
  }

  const key = pair.slice(0, equalsIndex);
  const value = pair.slice(equalsIndex + 1);
  env[key] = value;
}

const [command, ...args] = commandArgs;
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env,
  shell: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
