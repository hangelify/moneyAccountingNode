# AGENTS.md

Notes for AI coding agents working in this repository (NestJS 11 + MikroORM 7 + PostgreSQL 16, Node 24).

## Architecture

- A module is `src/modules/<m>/`. Other code imports it only through `src/modules/<m>/index.ts`, its Nest module through `<m>.module.ts`, test doubles through `testing.ts` (tests only).
- Controller → service → `EntityManager`. Controllers never touch `@mikro-orm/*`.
- `src/entities` holds every entity; `src/common`, `src/types`, `src/constants` and `src/entities` never import a module.
- Never re-export a `*Module` from an `index.ts`: barrels hold leaves and services only.

## Commands

- `npm run verify` — type-check, lint, architecture, copy-paste, dead code, unit tests. The same gate as CI.
- `npm run test:e2e` — e2e and integration tests (needs PostgreSQL on localhost).
- `npm run migration:create` — new migration from entity changes. Then read README, "Rules for new migrations".

## Done means

1. `npm run verify` is green.
2. A test covers the new or changed behaviour.
3. Entity changes come with a migration, and `npm run migration:drift` is clean.

## Never

- Weaken a check to make it pass: no `eslint-disable`, `@ts-ignore`, `as any`; no edits to lint, architecture, knip, jscpd, Squawk or tsconfig settings, or to their baselines.
- Edit a committed migration, or change the database outside migrations (`schema:update`, `schema:drop`, `migration:fresh` outside CI).
- `git push --force` or `--no-verify`.

The hooks in `.claude/settings.json` enforce most of this for Claude Code; CI enforces all of it.
