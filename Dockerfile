FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src
COPY scripts ./scripts

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./

# Install dependencies (including dev for migrations)
RUN npm ci

# Copy built application from builder
COPY --from=builder /app/dist ./dist
# The MikroORM CLI (migration:up in docker-entrypoint.sh) runs under ts-node,
# so it loads src/mikro-orm.config.ts and discovers entities via entitiesTs
# (src/**/*.entity.ts); migrations are .ts too. Ship the whole src tree.
COPY --from=builder /app/src ./src

# Copy entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Install postgresql-client for pg_isready
RUN apk add --no-cache postgresql-client

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

# Start the application with entrypoint script
ENTRYPOINT ["./docker-entrypoint.sh"]

