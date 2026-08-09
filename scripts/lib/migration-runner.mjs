import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MINIMUM_REQUEST_DELAY_MS = 30_000;

export function createRequestScheduler({
  minimumDelayMs = MINIMUM_REQUEST_DELAY_MS,
  now = () => Date.now(),
  sleep = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
} = {}) {
  let lastRequestStartedAt = null;

  return {
    async waitForTurn() {
      if (lastRequestStartedAt !== null) {
        const remaining = minimumDelayMs - (now() - lastRequestStartedAt);
        if (remaining > 0) await sleep(remaining);
      }
      lastRequestStartedAt = now();
    },
    async waitForRateLimit(retryAfterSeconds, resetAtSeconds) {
      const retryDelay = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1_000
        : 0;
      const resetDelay = Number.isFinite(resetAtSeconds)
        ? Math.max(0, resetAtSeconds * 1_000 - now()) + 100
        : 0;
      const delay = Math.max(retryDelay, resetDelay);
      if (delay > 0) await sleep(delay);
    },
  };
}

async function responseData(response) {
  try {
    return await response.json();
  } catch {
    return { error: 'Response was not valid JSON.' };
  }
}

export function createHabiticaClient({
  userId,
  apiKey,
  fetchImpl = globalThis.fetch,
  scheduler = createRequestScheduler(),
  baseUrl = 'https://habitica.com/api/v3',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  let rateLimitResetAt = null;

  return {
    async request(method, requestPath, body = null, retries = 3) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        await scheduler.waitForTurn();

        const response = await fetchImpl(`${baseUrl}${requestPath}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'x-api-user': userId,
            'x-api-key': apiKey,
            'x-client': `${userId}-HabiticaApiWorkspace`,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const reset = Number.parseInt(response.headers.get('x-ratelimit-reset'), 10);
        rateLimitResetAt = Number.isFinite(reset) ? reset : rateLimitResetAt;
        const data = await responseData(response);

        if (response.status !== 429 || attempt === retries - 1) {
          return { status: response.status, data };
        }

        const retryAfter = Number.parseInt(response.headers.get('retry-after'), 10);
        await scheduler.waitForRateLimit(
          Number.isFinite(retryAfter) ? retryAfter : undefined,
          rateLimitResetAt,
        );
      }
      throw new Error('Request retry loop completed unexpectedly.');
    },
  };
}

export async function getMigrationFiles(migrationsDir) {
  try {
    return (await fs.readdir(migrationsDir))
      .filter(filename => filename.endsWith('.mjs') && !filename.startsWith('.'))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadAppliedMigrations(appliedFile) {
  try {
    return (await fs.readFile(appliedFile, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveAppliedMigration(appliedFile, filename) {
  const applied = await loadAppliedMigrations(appliedFile);
  await fs.mkdir(path.dirname(appliedFile), { recursive: true });
  await fs.writeFile(appliedFile, `${[...applied, filename].join('\n')}\n`);
}

async function loadTasks(migrationPath) {
  const module = await import(pathToFileURL(migrationPath).href);
  const tasks = module.default || module.tasks || [];
  if (!Array.isArray(tasks)) {
    throw new Error('Migration must export a default array or named "tasks" array.');
  }
  return tasks;
}

async function ensureTags(client, tagNames) {
  const { status, data } = await client.request('GET', '/tags');
  if (status !== 200) throw new Error(`Unable to load tags (HTTP ${status}).`);

  const tagMap = Object.fromEntries((data.data || []).map(tag => [tag.name, tag.id]));
  for (const tagName of tagNames) {
    if (tagMap[tagName]) continue;
    const result = await client.request('POST', '/tags', { name: tagName });
    if (result.status !== 200 && result.status !== 201) {
      throw new Error(`Unable to create tag "${tagName}" (HTTP ${result.status}).`);
    }
    tagMap[tagName] = result.data.data?.id;
  }
  return tagMap;
}

async function createOrUpdateTask(client, taskSpec, tagMap) {
  const { text, operation, tags, ...taskData } = taskSpec;
  if (!text || !['create', 'update'].includes(operation)) {
    throw new Error('Each task needs text and an operation of "create" or "update".');
  }

  const payload = {
    text,
    ...taskData,
    ...(tags?.length ? { tags: tags.map(tag => tagMap[tag]).filter(Boolean) } : {}),
  };
  const current = await client.request('GET', '/tasks/user');
  if (current.status !== 200) throw new Error(`Unable to load tasks (HTTP ${current.status}).`);
  const existing = (current.data.data || []).find(task => task.text === text);

  if (operation === 'create') {
    if (existing) return { action: 'skipped', text };
    const result = await client.request('POST', '/tasks/user', payload);
    if (result.status === 200 || result.status === 201) return { action: 'created', text };
    throw new Error(`Unable to create "${text}" (HTTP ${result.status}).`);
  }

  if (!existing) return { action: 'skipped', text };
  const result = await client.request('PUT', `/tasks/${existing.id}`, payload);
  if (result.status === 200) return { action: 'updated', text };
  throw new Error(`Unable to update "${text}" (HTTP ${result.status}).`);
}

export async function applyMigration({ migrationPath, appliedFile, client, apply }) {
  const tasks = await loadTasks(migrationPath);
  const filename = path.basename(migrationPath);

  if (!apply) return { filename, status: 'dry-run', taskCount: tasks.length };

  const tagNames = [...new Set(tasks.flatMap(task => task.tags || []))];
  const tagMap = tagNames.length ? await ensureTags(client, tagNames) : {};
  const results = [];
  for (const task of tasks) results.push(await createOrUpdateTask(client, task, tagMap));

  await saveAppliedMigration(appliedFile, filename);
  return { filename, status: 'applied', taskCount: tasks.length, results };
}

export async function runMigrations({ migrationsDir, appliedFile, client, apply = false }) {
  const [files, applied] = await Promise.all([
    getMigrationFiles(migrationsDir),
    loadAppliedMigrations(appliedFile),
  ]);
  const pending = files.filter(filename => !applied.includes(filename));
  const results = [];

  for (const filename of pending) {
    try {
      results.push(await applyMigration({
        migrationPath: path.join(migrationsDir, filename),
        appliedFile,
        client,
        apply,
      }));
    } catch (error) {
      results.push({ filename, status: 'failed', error: error.message });
      break;
    }
  }

  return { files, applied, pending, results };
}
