import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigration,
  createHabiticaClient,
  createRequestScheduler,
} from '../scripts/lib/migration-runner.mjs';

test('scheduler enforces the minimum delay between requests', async () => {
  let time = 0;
  const delays = [];
  const scheduler = createRequestScheduler({
    minimumDelayMs: 30_000,
    now: () => time,
    sleep: async delay => { delays.push(delay); time += delay; },
  });
  await scheduler.waitForTurn();
  await scheduler.waitForTurn();
  assert.deepEqual(delays, [30_000]);
});

test('client honors Retry-After after a 429 response', async () => {
  const calls = [];
  const scheduler = {
    waitForTurn: async () => calls.push('turn'),
    waitForRateLimit: async retryAfter => calls.push(`retry:${retryAfter}`),
  };
  let attempt = 0;
  const client = createHabiticaClient({
    userId: 'user-id',
    apiKey: 'api-key',
    scheduler,
    fetchImpl: async (_url, options) => {
      attempt += 1;
      assert.equal(options.headers['x-client'], 'user-id-HabiticaApiWorkspace');
      return {
        status: attempt === 1 ? 429 : 200,
        headers: new Headers(attempt === 1 ? { 'retry-after': '30' } : {}),
        json: async () => ({ data: [] }),
      };
    },
  });
  assert.equal((await client.request('GET', '/tasks/user')).status, 200);
  assert.deepEqual(calls, ['turn', 'retry:30', 'turn']);
});

test('dry run never writes an applied marker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habitica-migration-'));
  const appliedFile = path.join(directory, '.applied');
  const migrationPath = path.resolve('test/fixtures/migrations/001-example.mjs');
  const result = await applyMigration({ migrationPath, appliedFile, client: null, apply: false });
  assert.equal(result.status, 'dry-run');
  await assert.rejects(fs.readFile(appliedFile, 'utf8'), { code: 'ENOENT' });
});

test('failed live migrations do not write an applied marker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habitica-migration-'));
  const appliedFile = path.join(directory, '.applied');
  const migrationPath = path.resolve('test/fixtures/migrations/001-example.mjs');
  const client = { request: async method => method === 'GET' ? { status: 200, data: { data: [] } } : { status: 500, data: {} } };
  await assert.rejects(applyMigration({ migrationPath, appliedFile, client, apply: true }));
  await assert.rejects(fs.readFile(appliedFile, 'utf8'), { code: 'ENOENT' });
});
