#!/usr/bin/env node

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHabiticaClient, runMigrations } from './lib/migration-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');
const appliedFile = path.join(migrationsDir, '.applied');

function usage() {
  console.log(`Usage: node scripts/apply-migrations.mjs [--apply]

Without --apply, this command only lists pending migrations and never sends an API request.
When applying, set HABITICA_USER_ID and HABITICA_API_KEY in .env or the environment.`);
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const help = argv.includes('--help') || argv.includes('-h');
  if (argv.some(arg => !['--apply', '--help', '-h'].includes(arg))) {
    throw new Error('Unknown argument.');
  }
  return { apply, help };
}

async function main() {
  const { apply, help } = parseArgs(process.argv.slice(2));
  if (help) return usage();

  dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const userId = process.env.HABITICA_USER_ID;
  const apiKey = process.env.HABITICA_API_KEY;
  if (apply && (!userId || !apiKey)) {
    throw new Error('HABITICA_USER_ID and HABITICA_API_KEY are required with --apply.');
  }

  const client = apply ? createHabiticaClient({ userId, apiKey }) : null;
  const result = await runMigrations({ migrationsDir, appliedFile, client, apply });
  console.log(`Migrations: ${result.files.length} total, ${result.applied.length} applied, ${result.pending.length} pending.`);
  for (const migration of result.results) {
    console.log(`${migration.status}: ${migration.filename} (${migration.taskCount ?? 0} task(s))`);
    if (migration.error) console.error(migration.error);
  }
  if (result.results.some(migration => migration.status === 'failed')) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
