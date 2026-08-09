# Habitica API Workspace Notes

- Scope: this is an unofficial API-documentation workspace. It is not the Habitica backend and is not affiliated with Habitica.
- Primary directories: `bruno/` contains a generated request collection, `openapi/` contains generated OpenAPI output, and `scripts/` contains tooling.
- Run `npm test` for offline validation. It must never send requests to Habitica.
- The Bruno collection includes destructive and privileged endpoints. Never run it recursively against a live service.
- The tracked Bruno environment deliberately points to `https://example.invalid`. Use explicit command-line overrides only for a request you have reviewed.
- `scripts/apply-migrations.mjs` is dry-run by default. `--apply` requires real credentials and sends live API requests with a 30-second minimum delay.
