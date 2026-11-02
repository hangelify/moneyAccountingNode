export function readOptionalKey(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function readModelWhenConfigured(
  keyName: string,
  modelName: string,
): string | undefined {
  if (!readOptionalKey(keyName)) return undefined;
  const m = process.env[modelName];
  if (!m || m.length === 0) {
    throw new Error(
      `${keyName} is set but ${modelName} is missing — configure a default model or remove the API key`,
    );
  }
  return m;
}
