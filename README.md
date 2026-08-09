# Habitica API Workspace

An unofficial, safety-first workspace for inspecting the Habitica HTTP API. It contains a generated OpenAPI 3.1 document, a Bruno request collection, a task-payload validator, and an opt-in migration runner. It is not affiliated with Habitica and is not the Habitica backend.

## Contents

- `openapi/` — generated OpenAPI 3.1 snapshot.
- `bruno/` — generated Bruno collection. It includes read-only, mutating, privileged, and destructive endpoints.
- `scripts/validate-task-payload.mjs` — offline validation for task create/update JSON.
- `scripts/apply-migrations.mjs` — a dry-run-first task migration utility.

## Setup and offline verification

Requires Node.js 20.19 or later.

```sh
npm ci
npm test
```

`npm test` is offline: it parses repository JSON/YAML, syntax-checks JavaScript, verifies public-safety guardrails, and runs fixtures. It never contacts Habitica.

Validate a payload directly:

```sh
npm run validate -- --mode create --file test/fixtures/valid-task.json
```

## Bruno safety

The tracked `Environment.example.yml` intentionally uses `https://example.invalid`, so an unreviewed request cannot reach production. Never run the collection recursively: it includes endpoints that can delete accounts, reset users, change credentials, or make purchases.

For a single reviewed status request, explicitly select the endpoint and production host:

```sh
cd bruno
bru run "Status/Get Habitica's API status.yml" --env "Environment example" --env-var baseUrl=https://habitica.com
```

Supply credentials only through Bruno's secret variables or command-line environment overrides. Do not commit populated Bruno environments, `.env` files, API keys, or user IDs.

## Task migrations

Copy a neutral migration from `examples/migrations/` into the ignored `scripts/migrations/` directory. Preview it first:

```sh
node scripts/apply-migrations.mjs
```

The default is dry-run and sends no requests. To make live changes, create `.env` from `.env.example`, review every migration, then explicitly opt in:

```sh
node scripts/apply-migrations.mjs --apply
```

Live migrations use the required `X-Client` header and wait at least 30 seconds between API calls. A migration is recorded only after every task operation succeeds.

## Regenerating the OpenAPI snapshot

The generator fetches Habitica's published API-documentation bundle and rewrites `openapi/habitica.openapi.json`:

```sh
npm run generate
git diff -- openapi/habitica.openapi.json
```

Review the generated diff before committing. The output records its source URL and generation timestamp. The generator has an offline fixture test; a production regeneration is intentionally manual.

## Attribution and licenses

The generated Bruno and OpenAPI artifacts derive from Habitica documentation. Original tooling is GPL-3.0-only; derived documentation is CC-BY-NC-SA-3.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

When using the live API, follow Habitica's [API Usage Guidelines](https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines), especially its rules for `X-Client`, automated request delays, and rate limits.
