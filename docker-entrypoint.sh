#!/bin/sh
# Don't use set -e so we can catch errors and log them

echo "=== Docker Entrypoint Started ==="
echo "DB_HOST: $DB_HOST"
echo "DB_PORT: $DB_PORT"
echo "DB_USER: $DB_USER"
echo "DB_NAME: $DB_NAME"

echo "Waiting for database to be ready..."
# Wait up to 60 seconds for database
timeout=60
elapsed=0
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" 2>/dev/null || [ $elapsed -ge $timeout ]; do
  echo "Database is unavailable - sleeping (${elapsed}s/${timeout}s)"
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ $elapsed -ge $timeout ]; then
  echo "ERROR: Database did not become ready within ${timeout} seconds"
  echo "Attempting to connect anyway..."
fi

echo "Database check completed!"

echo "Running migrations..."
if ! npm run migration:up; then
  echo "ERROR: Migrations failed"
  echo "Sleeping for 60 seconds to allow log inspection..."
  sleep 60
  exit 1
fi

echo "Starting application..."
if ! node dist/main.js; then
  echo "ERROR: Application failed to start"
  echo "Sleeping for 60 seconds to allow log inspection..."
  sleep 60
  exit 1
fi
