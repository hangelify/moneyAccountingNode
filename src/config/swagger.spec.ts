import { loadSwaggerOptions } from './swagger';

describe('loadSwaggerOptions', () => {
  it('disables Swagger in production by default', () => {
    expect(loadSwaggerOptions({ NODE_ENV: 'production' }).enabled).toBe(false);
  });

  it.each(['development', 'test', undefined])(
    'enables Swagger when NODE_ENV is %s',
    (nodeEnv) => {
      expect(loadSwaggerOptions({ NODE_ENV: nodeEnv }).enabled).toBe(true);
    },
  );

  it('lets SWAGGER_ENABLED override the default', () => {
    expect(
      loadSwaggerOptions({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })
        .enabled,
    ).toBe(true);
    expect(
      loadSwaggerOptions({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' })
        .enabled,
    ).toBe(false);
  });

  it('treats an empty SWAGGER_ENABLED as unset', () => {
    expect(
      loadSwaggerOptions({ NODE_ENV: 'production', SWAGGER_ENABLED: ' ' })
        .enabled,
    ).toBe(false);
  });

  it('fails startup on any other value', () => {
    expect(() => loadSwaggerOptions({ SWAGGER_ENABLED: 'yes' })).toThrow(
      'SWAGGER_ENABLED',
    );
  });

  it('persists authorization outside production only', () => {
    expect(loadSwaggerOptions({ NODE_ENV: 'development' })).toEqual({
      enabled: true,
      persistAuthorization: true,
    });
    expect(
      loadSwaggerOptions({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
    ).toEqual({ enabled: true, persistAuthorization: false });
  });
});
