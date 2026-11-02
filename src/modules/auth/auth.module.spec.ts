// Importing the module (e.g. via AppModule at the top of an e2e spec) must
// not read JWT_* env: tests and tools set it after imports are evaluated.
describe('AuthModule', () => {
  const KEYS = ['JWT_SECRET', 'JWT_EXPIRES_IN_MS'] as const;
  const saved = KEYS.map((k) => process.env[k]);

  afterEach(() => {
    KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  });

  it('can be imported without JWT env set', () => {
    for (const k of KEYS) delete process.env[k];

    expect(() => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./auth.module');
      });
    }).not.toThrow();
  });
});
