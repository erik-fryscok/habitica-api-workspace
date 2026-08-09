import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('generator produces an OpenAPI document from a local fixture', async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'habitica-openapi-'));
  const outputFile = path.join(outputDirectory, 'openapi.json');
  const result = spawnSync(process.execPath, ['scripts/generate-habitica-openapi.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, HABITICA_APIDOC_BUNDLE_FILE: path.resolve('test/fixtures/apidoc.bundle.txt'), HABITICA_OPENAPI_OUTPUT_FILE: outputFile },
  });
  assert.equal(result.status, 0, result.stderr);
  const spec = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  assert.equal(spec.info.title, 'Fixture Habitica API');
  assert.equal(spec['x-generated-from'], 'https://apidoc.habitica.com/assets/main.bundle.js');
  assert.ok(spec.paths['/api/v3/status']);
});
