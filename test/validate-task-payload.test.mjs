import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function validate(fixture) {
  return spawnSync(process.execPath, ['scripts/validate-task-payload.mjs', '--mode', 'create', '--file', path.resolve('test/fixtures', fixture)], { encoding: 'utf8' });
}

test('accepts a valid create payload', () => assert.equal(validate('valid-task.json').status, 0));
test('rejects an invalid create payload', () => assert.notEqual(validate('invalid-task.json').status, 0));
