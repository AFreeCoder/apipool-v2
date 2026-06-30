#!/usr/bin/env node
/**
 * Environment-aware script wrapper
 *
 * Determines the env file to use and executes a command with the loaded env
 *
 * Usage:
 *   tsx scripts/with-env.ts <command> [args...]
 *   tsx scripts/with-env.ts --env=.env.production <command> [args...]
 *   tsx scripts/with-env.ts --env .env.production <command> [args...]
 *
 * Environment variables:
 *   ENV_FILE - specify env file (e.g., .env.production)
 *   NODE_ENV - auto-select .env.{NODE_ENV}
 *
 * Priority: --env argument > ENV_FILE env var > .env.{NODE_ENV} > .env.development (default)
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parse } from 'dotenv';

const localSqliteDefaults: Record<string, string> = {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file:data/local.db',
  DB_SCHEMA_FILE: './src/config/db/schema.sqlite.ts',
  DB_MIGRATIONS_OUT: './src/config/db/migrations_sqlite',
  DB_SINGLETON_ENABLED: 'true',
  DB_MAX_CONNECTIONS: '1',
};

// Parse command line arguments
const args = process.argv.slice(2);

// Check for --env argument (supports both --env file and --env=file formats)
let envFile: string;
const envIndex = args.findIndex((arg) => arg.startsWith('--env'));

if (envIndex !== -1) {
  const envArg = args[envIndex];
  if (envArg.includes('=')) {
    // --env=.env.production format
    envFile = envArg.split('=')[1];
    if (!envFile) {
      console.error(
        '❌ Error: --env= requires a value (e.g., --env=.env.production)'
      );
      process.exit(1);
    }
    // Remove --env=... from args
    args.splice(envIndex, 1);
  } else {
    // --env .env.production format
    envFile = args[envIndex + 1];
    if (!envFile) {
      console.error(
        '❌ Error: --env requires a value (e.g., --env .env.production)'
      );
      process.exit(1);
    }
    // Remove --env and the value from args
    args.splice(envIndex, 2);
  }
} else {
  // Determine env file with priority:
  // 1. ENV_FILE environment variable
  // 2. .env.{NODE_ENV} based on NODE_ENV
  // 3. .env.development (default)
  envFile =
    process.env.ENV_FILE ||
    (process.env.NODE_ENV
      ? `.env.${process.env.NODE_ENV}`
      : '.env.development');
}

// Get command and arguments (after removing --env)
if (args.length === 0) {
  console.error('❌ Error: No command provided');
  process.exit(1);
}

const command = args.join(' ');

const parsedEnv = existsSync(envFile)
  ? parse(readFileSync(envFile))
  : {};
const childEnv: NodeJS.ProcessEnv = { ...parsedEnv, ...process.env };

if (basename(envFile) === '.env.development') {
  const provider = childEnv.DATABASE_PROVIDER ?? '';

  if (provider === '' || provider === 'sqlite') {
    const appliedDefaults: string[] = [];

    for (const [key, value] of Object.entries(localSqliteDefaults)) {
      if (!childEnv[key]) {
        childEnv[key] = value;
        appliedDefaults.push(key);
      }
    }

    if (appliedDefaults.length > 0) {
      console.log(
        `Using local SQLite defaults for missing env: ${appliedDefaults.join(', ')}`
      );
    }
  }
}

console.log(`📄 Loading environment from: ${envFile}`);
console.log(`▶️  Executing: ${command}\n`);

try {
  const [commandBin, ...commandArgs] = args;
  const result = spawnSync(commandBin, commandArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: childEnv,
    shell: true,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
} catch (error) {
  process.exit(1);
}
