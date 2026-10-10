import { loadAiCallConfig } from './ai-call-config';

describe('loadAiCallConfig', () => {
  it('applies defaults when the variables are unset or empty', () => {
    const cfg = loadAiCallConfig({ AI_CALL_TIMEOUT_MS: '' });
    expect(cfg).toMatchObject({
      callTimeoutMs: 60_000,
      retryAttempts: 2,
      retryBackoffMs: 500,
      taskDeadlineMs: 90_000,
    });
  });

  it('reads explicit values', () => {
    const cfg = loadAiCallConfig({
      AI_CALL_TIMEOUT_MS: '30000',
      AI_TRANSIENT_RETRY_ATTEMPTS: '0',
      AI_TRANSIENT_RETRY_BACKOFF_MS: '250',
      AI_TASK_DEADLINE_MS: '45000',
    });
    expect(cfg).toMatchObject({
      callTimeoutMs: 30_000,
      retryAttempts: 0,
      retryBackoffMs: 250,
      taskDeadlineMs: 45_000,
    });
  });

  it.each([
    ['AI_TRANSIENT_RETRY_ATTEMPTS', 'abc'],
    ['AI_TRANSIENT_RETRY_ATTEMPTS', '-1'],
    ['AI_CALL_TIMEOUT_MS', '0'],
    ['AI_CALL_TIMEOUT_MS', '1.5'],
    ['AI_TRANSIENT_RETRY_BACKOFF_MS', '10ms'],
    ['AI_TASK_DEADLINE_MS', 'NaN'],
  ])('fails fast naming the variable when %s=%s', (name, value) => {
    expect(() => loadAiCallConfig({ [name]: value })).toThrow(name);
  });
});
