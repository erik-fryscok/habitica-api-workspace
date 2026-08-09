#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'node_modules']);

async function filesUnder(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : filesUnder(target);
    return [target];
  }));
  return nested.flat();
}

async function main() {
  const files = await filesUnder(root);
  const errors = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    const text = await fs.readFile(file, 'utf8');
    if (file.endsWith('.json')) {
      try { JSON.parse(text); } catch (error) { errors.push(`${relative}: invalid JSON (${error.message})`); }
    }
    if (file.endsWith('.yml')) {
      const document = parseDocument(text);
      for (const error of document.errors) errors.push(`${relative}: invalid YAML (${error.message})`);
    }
    if (/^bruno\/Task\/[a-z]/.test(relative) && relative !== 'bruno/Task/folder.yml') {
      errors.push(`${relative}: custom task requests are not allowed in the public collection.`);
    }
  }

  for (const file of files.filter(file => file.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) errors.push(`${path.relative(root, file)}: ${result.stderr}`);
  }

  const environment = await fs.readFile(path.join(root, 'bruno/environments/Environment.example.yml'), 'utf8');
  if (!environment.includes('https://example.invalid')) errors.push('Example Bruno environment must be non-routable.');
  const agentNotes = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  if (agentNotes.includes('bru run .')) errors.push('Unsafe recursive Bruno command found.');

  if (errors.length) throw new Error(`Repository check failed:\n${errors.map(error => `- ${error}`).join('\n')}`);
  console.log(`Repository check passed (${files.length} files).`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
