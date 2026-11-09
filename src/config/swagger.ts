export interface SwaggerOptions {
  /** Serve Swagger UI at /api and the document at /api-json. */
  enabled: boolean;
  /** Swagger UI keeps the entered token in the browser's localStorage. */
  persistAuthorization: boolean;
}

/**
 * Swagger settings from the environment. `SWAGGER_ENABLED` defaults to false
 * in production and true otherwise; the token is never persisted in
 * production, even when Swagger is turned on there.
 */
export function loadSwaggerOptions(
  env: NodeJS.ProcessEnv = process.env,
): SwaggerOptions {
  const production = env.NODE_ENV === 'production';
  const raw = env.SWAGGER_ENABLED?.trim();
  let enabled: boolean;
  if (raw === undefined || raw === '') enabled = !production;
  else if (raw === 'true') enabled = true;
  else if (raw === 'false') enabled = false;
  else {
    throw new Error(
      `Invalid SWAGGER_ENABLED='${env.SWAGGER_ENABLED}': expected 'true' or 'false'`,
    );
  }
  return { enabled, persistAuthorization: !production };
}
