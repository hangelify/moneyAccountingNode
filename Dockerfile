# Stages: deps -> test (lint, type-check, unit tests) | builder -> runtime.
# Jenkins builds `--target test`, then `--target runtime`; a plain
# `docker build .` produces the runtime image (last stage).

FROM node:24-alpine AS deps

WORKDIR /app

# husky (the `prepare` script) is only needed for local git hooks
COPY package*.json ./
RUN npm pkg delete scripts.prepare && npm ci

# --- Lint, type check and unit tests (no database needed) ---
FROM deps AS test

COPY tsconfig*.json nest-cli.json eslint.config.mjs .prettierrc ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run lint:check && npm run type-check && npm test

# --- Build ---
FROM deps AS builder

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# --- Production image ---
FROM node:24-alpine AS runtime

WORKDIR /app

# curl for the health check, postgresql-client for pg_isready in the entrypoint
RUN apk add --no-cache curl postgresql-client

# Production dependencies only: the MikroORM CLI (migration:up) loads the
# compiled dist/mikro-orm.config.js and dist/migrations, so ts-node and the
# TypeScript sources are not needed.
COPY package*.json ./
RUN npm pkg delete scripts.prepare \
  && npm ci --omit=dev \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The MikroORM 7 CLI prefers the TypeScript config, entities and migrations
# (src/) whenever it is not told otherwise; the image only ships dist/.
ENV MIKRO_ORM_CLI_PREFER_TS=false

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
