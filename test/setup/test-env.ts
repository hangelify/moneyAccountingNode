// Env for the e2e/integration run. Applied in the Jest main process (global
// setup) and in every worker before the first spec import, so no external
// .env is needed. Only the Postgres server may come from outside (CI service,
// docker compose); the database itself is always a throw-away one.

export const DEFAULT_TEST_DB_NAME = 'accounting_e2e';

// The test database is dropped and recreated on every run.
export function testDbName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.E2E_DB_NAME || DEFAULT_TEST_DB_NAME;
  if (!/^[a-z0-9_]+_(e2e|test)$/.test(name)) {
    throw new Error(
      `E2E_DB_NAME "${name}" must end with _e2e or _test: the database is dropped on every run`,
    );
  }
  return name;
}

export function applyTestEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.NODE_ENV = 'test';

  env.DB_HOST ||= 'localhost';
  env.DB_PORT ||= '5432';
  env.DB_USER ||= 'postgres';
  env.DB_PASSWORD ||= 'postgres';
  env.DB_NAME = testDbName(env);

  env.FRONTEND_URL = 'http://frontend.e2e.test';
  env.JWT_SECRET = 'e2e-access-secret-at-least-32-characters-long';
  env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-at-least-32-characters-long';
  env.JWT_EXPIRES_IN_MS = '900000';
  env.JWT_REFRESH_EXPIRES_IN_MS = '604800000';
  env.JWT_ISSUER = 'https://api.e2e.test';
  env.JWT_AUDIENCE = 'e2e-clients';
  delete env.TRUST_PROXY;

  // Configured, never contacted: specs stub S3 and the AI calls they need.
  env.S3_REGION = 'us-east-1';
  env.S3_BUCKET = 'e2e';
  env.S3_ACCESS_KEY = 'e2e';
  env.S3_SECRET_KEY = 'e2e';
  env.S3_ENDPOINT = 'http://127.0.0.1:1';
  env.S3_FORCE_PATH_STYLE = 'true';
  env.ANTHROPIC_API_KEY = 'e2e-dummy-key';
  env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
  delete env.OPENAI_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  for (const name of Object.keys(env)) {
    if (name.startsWith('AI_')) delete env[name];
  }
}
