#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_FILE = path.resolve('schemas/task-payload.schema.json');
const TASK_TYPES = new Set(['habit', 'daily', 'todo', 'reward']);
const ATTRIBUTES = new Set(['str', 'int', 'per', 'con']);
const PRIORITIES = new Set([0.1, 1, 1.5, 2]);
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const DAILY_ONLY_FIELDS = new Set([
  'frequency',
  'repeat',
  'everyX',
  'streak',
  'daysOfMonth',
  'weeksOfMonth',
  'startDate',
]);
const HABIT_ONLY_FIELDS = new Set(['up', 'down']);
const REWARD_ONLY_FIELDS = new Set(['value']);
const TODO_ONLY_FIELDS = new Set(['date']);

function usage() {
  console.log(
    'Usage: node scripts/validate-task-payload.mjs --mode <create|update> --file <payload.json> [--task-type <habit|daily|todo|reward>]',
  );
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--mode') {
      args.mode = value;
      i += 1;
      continue;
    }

    if (key === '--file') {
      args.file = value;
      i += 1;
      continue;
    }

    if (key === '--task-type') {
      args.taskType = value;
      i += 1;
      continue;
    }

    if (key === '--help' || key === '-h') {
      args.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${key}`);
  }

  return args;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateDateLike(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateChecklistItem(item, index, errors) {
  if (!isObject(item)) {
    errors.push(`checklist[${index}] must be an object.`);
    return;
  }

  const allowed = new Set(['text', 'completed']);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) {
      errors.push(`checklist[${index}].${key} is not allowed.`);
    }
  }

  if (typeof item.text !== 'string' || item.text.trim().length === 0) {
    errors.push(`checklist[${index}].text must be a non-empty string.`);
  }

  if (item.completed !== undefined && typeof item.completed !== 'boolean') {
    errors.push(`checklist[${index}].completed must be a boolean.`);
  }
}

function validateReminder(reminder, index, errors) {
  if (!isObject(reminder)) {
    errors.push(`reminders[${index}] must be an object.`);
    return;
  }

  const allowed = new Set(['id', 'startDate', 'time']);
  for (const key of Object.keys(reminder)) {
    if (!allowed.has(key)) {
      errors.push(`reminders[${index}].${key} is not allowed.`);
    }
  }

  if (typeof reminder.id !== 'string' || !UUID_RE.test(reminder.id)) {
    errors.push(`reminders[${index}].id must be a valid UUID.`);
  }

  if (!validateDateLike(reminder.startDate)) {
    errors.push(`reminders[${index}].startDate must be a non-empty string.`);
  }

  if (!validateDateLike(reminder.time)) {
    errors.push(`reminders[${index}].time must be a non-empty string.`);
  }
}

function validateRepeat(repeat, errors) {
  if (!isObject(repeat)) {
    errors.push('repeat must be an object (keys: su, m, t, w, th, f, s).');
    return;
  }

  const allowed = new Set(['su', 'm', 't', 'w', 'th', 'f', 's']);
  const keys = Object.keys(repeat);

  if (keys.length === 0) {
    errors.push('repeat must contain at least one weekday key.');
    return;
  }

  for (const key of keys) {
    if (!allowed.has(key)) {
      errors.push(`repeat.${key} is not allowed.`);
      continue;
    }

    if (typeof repeat[key] !== 'boolean') {
      errors.push(`repeat.${key} must be a boolean.`);
    }
  }
}

function validateCoreTypes(payload, mode, errors) {
  if (mode === 'create') {
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
      errors.push('text is required and must be a non-empty string for create payloads.');
    }

    if (!TASK_TYPES.has(payload.type)) {
      errors.push('type is required and must be one of: habit, daily, todo, reward.');
    }
  }

  if (mode === 'update' && Object.keys(payload).length === 0) {
    errors.push('update payload must include at least one field.');
  }

  if (payload.text !== undefined && (typeof payload.text !== 'string' || payload.text.trim().length === 0)) {
    errors.push('text must be a non-empty string.');
  }

  if (payload.type !== undefined && !TASK_TYPES.has(payload.type)) {
    errors.push('type must be one of: habit, daily, todo, reward.');
  }

  if (payload.tags !== undefined) {
    if (!Array.isArray(payload.tags)) {
      errors.push('tags must be an array of UUID strings.');
    } else {
      payload.tags.forEach((tag, index) => {
        if (typeof tag !== 'string' || !UUID_RE.test(tag)) {
          errors.push(`tags[${index}] must be a valid UUID string.`);
        }
      });
    }
  }

  if (payload.alias !== undefined && (typeof payload.alias !== 'string' || payload.alias.trim().length === 0)) {
    errors.push('alias must be a non-empty string when provided.');
  }

  if (payload.attribute !== undefined && !ATTRIBUTES.has(payload.attribute)) {
    errors.push('attribute must be one of: str, int, per, con.');
  }

  if (payload.checklist !== undefined) {
    if (!Array.isArray(payload.checklist)) {
      errors.push('checklist must be an array.');
    } else {
      payload.checklist.forEach((item, index) => validateChecklistItem(item, index, errors));
    }
  }

  if (payload.collapseChecklist !== undefined && typeof payload.collapseChecklist !== 'boolean') {
    errors.push('collapseChecklist must be a boolean.');
  }

  if (payload.notes !== undefined && typeof payload.notes !== 'string') {
    errors.push('notes must be a string.');
  }

  if (payload.date !== undefined && !validateDateLike(payload.date)) {
    errors.push('date must be a non-empty string.');
  }

  if (payload.priority !== undefined && !PRIORITIES.has(payload.priority)) {
    errors.push('priority must be one of: 0.1, 1, 1.5, 2.');
  }

  if (payload.reminders !== undefined) {
    if (!Array.isArray(payload.reminders)) {
      errors.push('reminders must be an array.');
    } else {
      payload.reminders.forEach((item, index) => validateReminder(item, index, errors));
    }
  }

  if (payload.frequency !== undefined && !FREQUENCIES.has(payload.frequency)) {
    errors.push('frequency must be one of: daily, weekly, monthly, yearly.');
  }

  if (payload.repeat !== undefined) {
    validateRepeat(payload.repeat, errors);
  }

  if (payload.everyX !== undefined && (typeof payload.everyX !== 'number' || payload.everyX < 1)) {
    errors.push('everyX must be a number >= 1.');
  }

  if (payload.streak !== undefined && (typeof payload.streak !== 'number' || payload.streak < 0)) {
    errors.push('streak must be a number >= 0.');
  }

  if (payload.daysOfMonth !== undefined) {
    if (!Array.isArray(payload.daysOfMonth)) {
      errors.push('daysOfMonth must be an array of integers between 1 and 31.');
    } else {
      payload.daysOfMonth.forEach((day, index) => {
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          errors.push(`daysOfMonth[${index}] must be an integer between 1 and 31.`);
        }
      });
    }
  }

  if (payload.weeksOfMonth !== undefined) {
    if (!Array.isArray(payload.weeksOfMonth)) {
      errors.push('weeksOfMonth must be an array of integers between 1 and 5.');
    } else {
      payload.weeksOfMonth.forEach((week, index) => {
        if (!Number.isInteger(week) || week < 1 || week > 5) {
          errors.push(`weeksOfMonth[${index}] must be an integer between 1 and 5.`);
        }
      });
    }
  }

  if (payload.startDate !== undefined && !validateDateLike(payload.startDate)) {
    errors.push('startDate must be a non-empty string.');
  }

  if (payload.up !== undefined && typeof payload.up !== 'boolean') {
    errors.push('up must be a boolean.');
  }

  if (payload.down !== undefined && typeof payload.down !== 'boolean') {
    errors.push('down must be a boolean.');
  }

  if (payload.value !== undefined && (typeof payload.value !== 'number' || payload.value < 0)) {
    errors.push('value must be a number >= 0.');
  }
}

function validateTypeSpecificRules(payload, mode, taskTypeHint, errors) {
  const effectiveType = payload.type || taskTypeHint;

  if (mode === 'create' && !effectiveType) {
    errors.push('create payload requires type.');
    return;
  }

  if (!effectiveType) {
    return;
  }

  if (effectiveType !== 'daily') {
    for (const field of DAILY_ONLY_FIELDS) {
      if (Object.hasOwn(payload, field)) {
        errors.push(`${field} is only valid for type "daily".`);
      }
    }
  }

  if (effectiveType !== 'habit') {
    for (const field of HABIT_ONLY_FIELDS) {
      if (Object.hasOwn(payload, field)) {
        errors.push(`${field} is only valid for type "habit".`);
      }
    }
  }

  if (effectiveType !== 'reward') {
    for (const field of REWARD_ONLY_FIELDS) {
      if (Object.hasOwn(payload, field)) {
        errors.push(`${field} is only valid for type "reward".`);
      }
    }
  }

  if (effectiveType !== 'todo') {
    for (const field of TODO_ONLY_FIELDS) {
      if (Object.hasOwn(payload, field)) {
        errors.push(`${field} is only valid for type "todo".`);
      }
    }
  }

  if (Object.hasOwn(payload, 'repeat') && payload.frequency !== undefined && payload.frequency !== 'weekly') {
    errors.push('repeat is only valid when frequency is "weekly".');
  }

  const hasMonthlyFields = Object.hasOwn(payload, 'daysOfMonth') || Object.hasOwn(payload, 'weeksOfMonth');
  if (hasMonthlyFields && payload.frequency !== undefined && payload.frequency !== 'monthly') {
    errors.push('daysOfMonth and weeksOfMonth are only valid when frequency is "monthly".');
  }
}

async function loadSchema() {
  const text = await fs.readFile(SCHEMA_FILE, 'utf8');
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!args.mode || !args.file) {
    usage();
    throw new Error('Both --mode and --file are required.');
  }

  if (args.mode !== 'create' && args.mode !== 'update') {
    throw new Error('mode must be either "create" or "update".');
  }

  if (args.taskType && !TASK_TYPES.has(args.taskType)) {
    throw new Error('task-type must be one of: habit, daily, todo, reward.');
  }

  await loadSchema();

  const payloadFile = path.resolve(args.file);
  const payloadText = await fs.readFile(payloadFile, 'utf8');
  const payload = JSON.parse(payloadText);

  if (!isObject(payload)) {
    throw new Error('payload must be a JSON object.');
  }

  const errors = [];
  validateCoreTypes(payload, args.mode, errors);
  validateTypeSpecificRules(payload, args.mode, args.taskType, errors);

  if (errors.length > 0) {
    console.error('Validation failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const schemaRef = args.mode === 'create' ? '#/$defs/createPayload' : '#/$defs/updatePayload';
  console.log(`Payload is valid (${schemaRef}).`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
