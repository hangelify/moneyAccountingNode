export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  /** Sender address, e.g. `Money <no-reply@example.com>`. */
  from: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function readMailConfig(
  env: NodeJS.ProcessEnv = process.env,
): MailConfig {
  const host = required(env, 'SMTP_HOST');
  const rawPort = required(env, 'SMTP_PORT');
  if (
    !/^\d+$/.test(rawPort) ||
    Number(rawPort) < 1 ||
    Number(rawPort) > 65535
  ) {
    throw new Error(`SMTP_PORT must be a port number, got "${rawPort}"`);
  }

  const rawSecure = env.SMTP_SECURE?.trim() || 'false';
  if (rawSecure !== 'true' && rawSecure !== 'false') {
    throw new Error(`SMTP_SECURE must be true or false, got "${rawSecure}"`);
  }

  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error('SMTP_USER and SMTP_PASS must be set together');
  }

  return {
    host,
    port: Number(rawPort),
    secure: rawSecure === 'true',
    auth: user && pass ? { user, pass } : undefined,
    from: required(env, 'MAIL_FROM'),
  };
}
