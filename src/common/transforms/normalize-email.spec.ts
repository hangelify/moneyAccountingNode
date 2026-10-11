import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RegisterDto } from '../../modules/auth/dto/register.dto';
import { LoginDto } from '../../modules/auth/dto/login.dto';
import { CreateInviteDto } from '../../modules/household/dto/create-invite.dto';

describe('email normalization in request DTOs', () => {
  const base = { password: 'password123', first_name: 'Test' };

  it.each([
    ['RegisterDto', RegisterDto],
    ['LoginDto', LoginDto],
    ['CreateInviteDto', CreateInviteDto],
  ] as const)(
    '%s trims and lowercases email before validation',
    async (_, cls) => {
      const dto = plainToInstance(cls, { ...base, email: '  User@X.COM ' });
      expect(dto.email).toBe('user@x.com');
      expect(
        (await validate(dto)).filter((e) => e.property === 'email'),
      ).toHaveLength(0);
    },
  );

  it('leaves a non-string email for the validator to reject', async () => {
    const dto = plainToInstance(LoginDto, { ...base, email: 42 });
    expect(dto.email).toBe(42);
    expect((await validate(dto)).some((e) => e.property === 'email')).toBe(
      true,
    );
  });
});
