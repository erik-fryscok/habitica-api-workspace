#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const APIDOC_URL = 'https://apidoc.habitica.com/assets/main.bundle.js';
const OUT_FILE = path.resolve(process.env.HABITICA_OPENAPI_OUTPUT_FILE || 'openapi/habitica.openapi.json');
const BRUNO_COLLECTION_FILE = path.resolve('bruno/opencollection.yml');
const APIDOC_BUNDLE_FILE = process.env.HABITICA_APIDOC_BUNDLE_FILE;
const DEFAULT_AUTH_HEADERS = [
  { name: 'x-api-user', value: '{{userId}}' },
  { name: 'x-api-key', value: '{{apiKey}}' },
  { name: 'x-client', value: '{{userId}}-Testing' },
];

function stripHtml(input = '') {
  return input
    .replace(/<\/?p>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePath(url) {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function mapType(type) {
  const raw = (type || 'string').trim();
  const normalized = raw.toLowerCase();

  if (normalized.endsWith('[]')) {
    return {
      type: 'array',
      items: mapType(raw.slice(0, -2)),
    };
  }

  if (normalized === 'array') {
    return {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    };
  }

  if (normalized === 'string' || normalized === 'html') {
    return { type: 'string' };
  }

  if (normalized === 'uuid' || normalized === 'guid') {
    return { type: 'string', format: 'uuid' };
  }

  if (normalized === 'date') {
    return { type: 'string', format: 'date-time' };
  }

  if (normalized === 'integer') {
    return { type: 'integer' };
  }

  if (normalized === 'number') {
    return { type: 'number' };
  }

  if (normalized === 'boolean') {
    return { type: 'boolean' };
  }

  if (
    normalized === 'object' ||
    normalized === 'anything' ||
    normalized === 'badrequest' ||
    normalized === 'notauthorized' ||
    normalized === 'notfound'
  ) {
    return { type: 'object', additionalProperties: true };
  }

  if (normalized === 'json') {
    return { type: 'object', additionalProperties: true };
  }

  if (normalized === 'xml' || normalized === 'csv') {
    return { type: 'string' };
  }

  return { type: 'string' };
}

function parseExample(raw) {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();

  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Best-effort normalization for pseudo-JSON examples.
    const maybeJson = trimmed
      .replace(/'([^']+)'\s*:/g, '"$1":')
      .replace(/:\s*'([^']+)'/g, ': "$1"')
      .replace(/,\s*([}\]])/g, '$1');

    try {
      return JSON.parse(maybeJson);
    } catch {
      return trimmed;
    }
  }
}

function castScalarToSchemaType(value, schemaType) {
  if (schemaType === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }

  if (schemaType === 'integer') {
    const n = Number(value);
    return Number.isInteger(n) ? n : value;
  }

  if (schemaType === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return value;
}

function normalizeEnumValues(values, schema) {
  return values.map(rawValue => {
    const normalized = String(rawValue).replace(/^"|"$/g, '');
    return castScalarToSchemaType(normalized, schema.type);
  });
}

function buildParameters(paramFields = {}) {
  const parameters = [];
  const bodyFields = [];

  for (const [section, fields] of Object.entries(paramFields)) {
    const sectionLower = section.toLowerCase();
    const isPath = sectionLower.includes('path');
    const isQuery = sectionLower.includes('query');
    const isBody = sectionLower.includes('body');

    for (const field of fields) {
      if (isBody) {
        bodyFields.push(field);
        continue;
      }

      if (!isPath && !isQuery) continue;

      const schema = mapType(field.type);
      if (Array.isArray(field.allowedValues) && field.allowedValues.length > 0) {
        schema.enum = normalizeEnumValues(field.allowedValues, schema);
      }

      parameters.push({
        name: field.field,
        in: isPath ? 'path' : 'query',
        required: isPath ? true : !field.optional,
        description: stripHtml(field.description),
        schema,
      });
    }
  }

  let requestBody;
  if (bodyFields.length > 0) {
    const schema = {
      type: 'object',
      properties: {},
      required: [],
    };

    for (const field of bodyFields) {
      const fieldSchema = mapType(field.type);
      if (Array.isArray(field.allowedValues) && field.allowedValues.length > 0) {
        fieldSchema.enum = normalizeEnumValues(field.allowedValues, fieldSchema);
      }

      if (field.defaultValue !== undefined) {
        const parsedDefault = parseExample(String(field.defaultValue));
        if (typeof parsedDefault === 'string') {
          fieldSchema.default = castScalarToSchemaType(parsedDefault, fieldSchema.type);
        } else {
          fieldSchema.default = parsedDefault;
        }
      }

      if (field.description) {
        fieldSchema.description = stripHtml(field.description);
      }

      schema.properties[field.field] = fieldSchema;
      if (!field.optional) {
        schema.required.push(field.field);
      }
    }

    if (schema.required.length === 0) {
      delete schema.required;
    }

    requestBody = {
      required: schema.required !== undefined,
      content: {
        'application/json': {
          schema,
        },
      },
    };
  }

  return { parameters, requestBody };
}

function statusCodeFromKey(key, fallback) {
  if (!key) return fallback;
  const codeMatch = key.match(/\b(\d{3})\b/);
  if (codeMatch) return codeMatch[1];
  if (/success/i.test(key)) return '200';
  if (/error/i.test(key)) return '400';
  return fallback;
}

function inferContentType(fields = []) {
  for (const field of fields) {
    const t = String(field.type || '').toLowerCase();
    if (t === 'csv') return 'text/csv';
    if (t === 'xml') return 'application/xml';
    if (t === 'json') return 'application/json';
  }
  return 'application/json';
}

function buildResponses(endpoint) {
  const responses = {};

  const successFields = endpoint.success?.fields || {};
  for (const [section, fields] of Object.entries(successFields)) {
    const code = statusCodeFromKey(section, '200');
    const schema = { type: 'object', properties: {} };

    for (const field of fields) {
      if (!field.field) continue;
      schema.properties[field.field] = {
        ...mapType(field.type),
        ...(field.description
          ? { description: stripHtml(field.description) }
          : {}),
      };
    }

    if (Object.keys(schema.properties).length === 0) {
      delete schema.properties;
      schema.additionalProperties = true;
    }

    const contentType = inferContentType(fields);
    responses[code] = {
      description: section || 'Successful response',
      content: {
        [contentType]: {
          schema,
        },
      },
    };
  }

  const errorFields = endpoint.error?.fields || {};
  for (const [section, fields] of Object.entries(errorFields)) {
    const code = statusCodeFromKey(section, '400');
    const schema = { type: 'object', properties: {} };

    for (const field of fields) {
      if (!field.field) continue;
      schema.properties[field.field] = {
        ...mapType(field.type),
        ...(field.description
          ? { description: stripHtml(field.description) }
          : {}),
      };
    }

    if (Object.keys(schema.properties).length === 0) {
      delete schema.properties;
      schema.additionalProperties = true;
    }

    responses[code] = {
      description: section || 'Error response',
      content: {
        'application/json': {
          schema,
        },
      },
    };
  }

  if (Object.keys(responses).length === 0) {
    responses.default = {
      description: 'Response',
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: true },
        },
      },
    };
  }

  if (!Object.keys(responses).some(code => code.startsWith('2'))) {
    responses['200'] = {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: true },
        },
      },
    };
  }

  const successExample = endpoint.success?.examples?.[0]?.content;
  if (successExample) {
    const firstCode =
      Object.keys(responses).find(code => code.startsWith('2')) ||
      Object.keys(responses)[0];
    const mediaType = Object.keys(responses[firstCode].content || {})[0];
    if (mediaType) {
      responses[firstCode].content[mediaType].example = parseExample(successExample);
    }
  }

  return responses;
}

function makeOperationId(endpoint, usedOperationIds) {
  const base = `${endpoint.group}_${endpoint.name}`.replace(/[^A-Za-z0-9_]/g, '_');
  let operationId = base;
  let i = 2;
  while (usedOperationIds.has(operationId)) {
    operationId = `${base}_${i}`;
    i += 1;
  }
  usedOperationIds.add(operationId);
  return operationId;
}

function normalizePathParameters(pathTemplate, parameters = []) {
  const placeholders = Array.from(pathTemplate.matchAll(/\{([^}]+)\}/g)).map(match => match[1]);
  if (placeholders.length === 0) {
    return parameters.filter(parameter => parameter.in !== 'path');
  }

  const pathParameters = parameters.filter(parameter => parameter.in === 'path');
  const nonPathParameters = parameters.filter(parameter => parameter.in !== 'path');

  const byName = new Map(pathParameters.map(parameter => [parameter.name, parameter]));

  for (const placeholder of placeholders) {
    if (!byName.has(placeholder) && pathParameters.length === placeholders.length) {
      const candidate = pathParameters.find(parameter => !placeholders.includes(parameter.name));
      if (candidate) {
        byName.delete(candidate.name);
        candidate.name = placeholder;
        byName.set(placeholder, candidate);
      }
    }
  }

  const normalizedPathParameters = placeholders.map(placeholder => {
    const existing = byName.get(placeholder);
    if (existing) {
      return {
        ...existing,
        name: placeholder,
        in: 'path',
        required: true,
      };
    }

    return {
      name: placeholder,
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: `Path parameter: ${placeholder}`,
    };
  });

  return [...normalizedPathParameters, ...nonPathParameters];
}

function formatPermission(permission) {
  if (!permission) return '';
  if (typeof permission === 'string') return permission;
  if (typeof permission === 'object') {
    return Object.entries(permission)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  }
  return String(permission);
}

function parseBrunoAuthHeaders(opencollectionText) {
  const headers = [];
  const blockMatch = opencollectionText.match(/request:\s*\n(?:[ \t].*\n)+/m);
  if (!blockMatch) return headers;

  const requestBlock = blockMatch[0];
  const headerRegex = /-\s+name:\s*([^\n]+)\n\s+value:\s*([^\n]+)/g;
  let match;

  while ((match = headerRegex.exec(requestBlock)) !== null) {
    const name = match[1].trim().replace(/^"|"$/g, '');
    const value = match[2].trim().replace(/^"|"$/g, '');
    headers.push({ name, value });
  }

  return headers;
}

function headerDescription(header) {
  if (header.name === 'x-api-user') {
    return `Habitica user ID. Example from Bruno: ${header.value}`;
  }

  if (header.name === 'x-api-key') {
    return `Habitica API token. Example from Bruno: ${header.value}`;
  }

  if (header.name === 'x-client') {
    return `Client identifier. Example from Bruno: ${header.value}`;
  }

  return `Required header from Bruno collection. Example value: ${header.value}`;
}

function isPublicEndpoint(endpoint) {
  const text = `${endpoint.description || ''}\n${endpoint.title || ''}`;
  return /does(?:n't| not) require authentication/i.test(text);
}

function findObjectEnd(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function extractApidocPayload(bundle) {
  const projectStart = bundle.indexOf('={name:');
  if (projectStart === -1) throw new Error('Could not locate the apidoc project metadata.');

  const endpointsEnd = bundle.lastIndexOf('];', projectStart);
  const endpointsStart = bundle.lastIndexOf('=[', endpointsEnd);
  const projectEnd = findObjectEnd(bundle, projectStart + 1);
  if (endpointsStart === -1 || endpointsEnd === -1 || projectEnd === -1) {
    throw new Error('Could not locate the apidoc endpoint payload.');
  }

  return {
    endpointsExpression: bundle.slice(endpointsStart + 1, endpointsEnd + 1),
    projectExpression: bundle.slice(projectStart + 1, projectEnd),
  };
}

async function main() {
  let authHeaders = DEFAULT_AUTH_HEADERS;
  try {
    const opencollection = await fs.readFile(BRUNO_COLLECTION_FILE, 'utf8');
    const parsedHeaders = parseBrunoAuthHeaders(opencollection);
    if (parsedHeaders.length > 0) {
      authHeaders = parsedHeaders;
    }
  } catch {
    // Fall back to known Habitica auth headers when Bruno collection is unavailable.
  }

  const securitySchemes = {};
  const securityRequirement = {};
  for (const header of authHeaders) {
    securitySchemes[header.name] = {
      type: 'apiKey',
      in: 'header',
      name: header.name,
      description: headerDescription(header),
    };
    securityRequirement[header.name] = [];
  }

  const bundle = APIDOC_BUNDLE_FILE
    ? await fs.readFile(APIDOC_BUNDLE_FILE, 'utf8')
    : await fetch(APIDOC_URL).then(async response => {
      if (!response.ok) throw new Error(`Failed to fetch ${APIDOC_URL}: HTTP ${response.status}`);
      return response.text();
    });
  const { endpointsExpression, projectExpression } = extractApidocPayload(bundle);

  const endpoints = vm.runInNewContext(endpointsExpression, {});
  const project = vm.runInNewContext(`(${projectExpression})`, {});

  const spec = {
    openapi: '3.1.0',
    'x-generated-from': APIDOC_URL,
    'x-generated-at': new Date().toISOString(),
    info: {
      title: project.name || 'Habitica API',
      version: project.version || '3.0.0',
      license: {
        name: 'Mixed license; see NOTICE.md',
        url: 'https://github.com/erik-fryscok/habitica-api-workspace/blob/main/LICENSE',
      },
      description:
        `${stripHtml(project.header?.content || project.description || '')}` +
        '\n\n' +
        `Generated from ${APIDOC_URL} using scripts/generate-habitica-openapi.mjs.`,
    },
    servers: [
      {
        url: 'https://habitica.com',
      },
    ],
    tags: [],
    paths: {},
    security: [securityRequirement],
    components: {
      securitySchemes,
    },
  };

  const usedOperationIds = new Set();
  const tagNames = new Set();

  for (const endpoint of endpoints) {
    const method = endpoint.type.toLowerCase();
    const openapiPath = normalizePath(endpoint.url);
    if (!spec.paths[openapiPath]) {
      spec.paths[openapiPath] = {};
    }

    let { parameters, requestBody } = buildParameters(endpoint.parameter?.fields || {});
    parameters = normalizePathParameters(openapiPath, parameters);
    const responses = buildResponses(endpoint);

    const descriptionParts = [];
    if (endpoint.description) {
      descriptionParts.push(stripHtml(endpoint.description));
    }
    const permission = formatPermission(endpoint.permission);
    if (permission) {
      descriptionParts.push(`Permission: ${permission}`);
    }

    const operation = {
      tags: [endpoint.groupTitle || endpoint.group],
      summary: stripHtml(endpoint.title || endpoint.name),
      operationId: makeOperationId(endpoint, usedOperationIds),
      responses,
    };

    if (descriptionParts.length > 0) {
      operation.description = descriptionParts.join('\n\n');
    }
    if (parameters.length > 0) {
      operation.parameters = parameters;
    }
    if (requestBody) {
      operation.requestBody = requestBody;
    }
    if (isPublicEndpoint(endpoint)) {
      operation.security = [];
    }

    if (spec.paths[openapiPath][method]) {
      // Keep OpenAPI valid on duplicate method+path combinations.
      const previous = spec.paths[openapiPath][method];
      previous.description = [previous.description, 'Additional apidoc entry:', operation.summary]
        .filter(Boolean)
        .join('\n\n');
      continue;
    }

    spec.paths[openapiPath][method] = operation;
    tagNames.add(endpoint.groupTitle || endpoint.group);
  }

  spec.tags = Array.from(tagNames)
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({ name }));

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  console.log(`Generated ${OUT_FILE}`);
  console.log(`- operations: ${Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0)}`);
  console.log(`- paths: ${Object.keys(spec.paths).length}`);
  console.log(`- tags: ${spec.tags.length}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
