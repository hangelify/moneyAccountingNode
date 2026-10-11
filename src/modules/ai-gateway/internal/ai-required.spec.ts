import { loadAiRequired } from './ai-required';

describe('loadAiRequired', () => {
  it('defaults to true in production', () => {
    expect(loadAiRequired({ NODE_ENV: 'production' })).toBe(true);
  });

  it.each(['development', 'test', undefined])(
    'defaults to false when NODE_ENV is %s',
    (nodeEnv) => {
      expect(loadAiRequired({ NODE_ENV: nodeEnv })).toBe(false);
    },
  );

  it('lets AI_REQUIRED override the default', () => {
    expect(
      loadAiRequired({ NODE_ENV: 'production', AI_REQUIRED: 'false' }),
    ).toBe(false);
    expect(
      loadAiRequired({ NODE_ENV: 'development', AI_REQUIRED: 'true' }),
    ).toBe(true);
  });

  it('treats an empty AI_REQUIRED as unset', () => {
    expect(loadAiRequired({ NODE_ENV: 'production', AI_REQUIRED: ' ' })).toBe(
      true,
    );
  });

  it('fails startup on any other value', () => {
    expect(() => loadAiRequired({ AI_REQUIRED: 'yes' })).toThrow('AI_REQUIRED');
  });
});
