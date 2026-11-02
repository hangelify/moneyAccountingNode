import { ACCESS_TOKEN_TYP, hasTyp } from './token-format';

describe('hasTyp', () => {
  it.each(['at+jwt', 'AT+JWT', 'application/at+jwt', 'Application/At+Jwt'])(
    'accepts %p as at+jwt',
    (typ) => {
      expect(hasTyp(typ, ACCESS_TOKEN_TYP)).toBe(true);
    },
  );

  it.each([undefined, 'JWT', 'rt+jwt', 'text/at+jwt', 'at+jwt ', 42])(
    'rejects %p',
    (typ) => {
      expect(hasTyp(typ, ACCESS_TOKEN_TYP)).toBe(false);
    },
  );
});
