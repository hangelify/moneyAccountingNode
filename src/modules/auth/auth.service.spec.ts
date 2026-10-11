import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { AuthService } from './auth.service';
import { CategoryDefaultsService } from '../category/category-defaults.service';
import { User } from '../../entities/user.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Session } from '../../entities/session.entity';
import { Log } from '../../entities/log.entity';
import { PasswordService } from './password.service';

// Wrap the real bcrypt so calls can be counted (its exports are not spy-able).
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  const compare = (data: string, hash: string): Promise<boolean> =>
    actual.compare(data, hash);
  return { ...actual, compare: jest.fn(compare) };
});

/* eslint-disable @typescript-eslint/no-unsafe-return */

interface Deps {
  seedForHousehold: jest.Mock;
  findUser: jest.Mock;
  createSession: jest.Mock;
  createRefreshToken: jest.Mock;
  createLog: jest.Mock;
  updateUser: jest.Mock;
  persist: jest.Mock;
}

function makeService(opts?: Partial<Pick<Deps, 'seedForHousehold'>>): {
  service: AuthService;
  deps: Deps;
} {
  const seedForHousehold =
    opts?.seedForHousehold ??
    jest.fn().mockResolvedValue({
      categoriesCreated: 12,
      subCategoriesCreated: 70,
    });

  // env vars used by issueTokensForSession
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxxx';
  process.env.JWT_REFRESH_SECRET =
    'test-refresh-secret-at-least-32-chars-long-xxxxxx';
  process.env.JWT_EXPIRES_IN_MS = '900000';
  process.env.JWT_REFRESH_EXPIRES_IN_MS = '604800000';

  // Repository mocks: findOne returns null (no existing user) for user; create returns the entity passed.
  const createRefreshToken = jest.fn().mockImplementation((data) => data);
  const createSession = jest
    .fn()
    .mockImplementation((data) => ({ id: 'session-id', ...data }));
  const createLog = jest.fn().mockImplementation((data) => data);
  const findUser = jest.fn().mockResolvedValue(null);
  const updateUser = jest.fn().mockResolvedValue(1);
  const userRepo = {
    findOne: findUser,
    nativeUpdate: updateUser,
  } as unknown as EntityRepository<User>;
  const refreshTokenRepo = {} as unknown as EntityRepository<RefreshToken>;
  const sessionRepo = {
    create: createSession,
  } as unknown as EntityRepository<Session>;
  const logRepo = {
    create: createLog,
  } as unknown as EntityRepository<Log>;

  // EntityManager: persist().flush() chain. Side-effect: assigns an id to the user before flush returns.
  const persist = jest.fn().mockImplementation((entity: { id?: string }) => {
    if (entity && typeof entity === 'object' && !entity.id) {
      entity.id = 'user-' + Math.random().toString(36).slice(2);
    }
    return { flush: jest.fn().mockResolvedValue(undefined) };
  });
  const em = {
    // Only refresh rows are created through the EntityManager.
    create: jest
      .fn()
      .mockImplementation((_entity: unknown, data: unknown) =>
        createRefreshToken(data),
      ),
    persist,
    flush: jest.fn().mockResolvedValue(undefined),
    transactional: jest
      .fn()
      .mockImplementation((fn: (txEm: EntityManager) => Promise<unknown>) =>
        fn(em),
      ),
  } as unknown as EntityManager;

  const jwtService = {
    signAsync: jest.fn().mockResolvedValue('signed-token'),
    verify: jest.fn(),
  } as unknown as JwtService;

  const service = new AuthService(
    userRepo,
    refreshTokenRepo,
    sessionRepo,
    logRepo,
    em,
    jwtService,
    { seedForHousehold } as unknown as CategoryDefaultsService,
    new PasswordService(),
  );
  return {
    service,
    deps: {
      seedForHousehold,
      findUser,
      createSession,
      createRefreshToken,
      createLog,
      updateUser,
      persist,
    },
  };
}

describe('AuthService.register seeder hook', () => {
  it('seeds default categories for the new user after persist', async () => {
    const { service, deps } = makeService();
    await service.register(
      {
        email: 'new-user@test',
        password: 'supersecret-password',
        first_name: 'Test',
      },
      '1.2.3.4',
      'jest',
    );
    expect(deps.seedForHousehold).toHaveBeenCalledTimes(1);
    expect(deps.seedForHousehold).toHaveBeenCalledWith(expect.any(String));
  });

  it('does NOT fail registration when seedForHousehold throws', async () => {
    const { service } = makeService({
      seedForHousehold: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const tokens = await service.register(
      {
        email: 'new-user-2@test',
        password: 'supersecret-password',
        first_name: 'Test2',
      },
      '1.2.3.4',
      'jest',
    );
    expect(tokens.access_token).toBeDefined();
  });
});

describe('AuthService ip_address sanitization', () => {
  const registerDto = {
    email: 'ip-user@test',
    password: 'supersecret-password',
    first_name: 'Ip',
  };

  function persistedIps(deps: Deps): unknown[] {
    return [deps.createSession, deps.createRefreshToken, deps.createLog]
      .flatMap((create) => create.mock.calls)
      .map(([data]) => (data as { ip_address?: unknown }).ip_address);
  }

  it('stores null instead of a non-IP value that does not fit varchar(45)', async () => {
    const { service, deps } = makeService();
    await service.register(registerDto, 'x'.repeat(100), 'jest');

    const ips = persistedIps(deps);
    expect(ips).toHaveLength(3);
    for (const ip of ips) expect(ip).toBeNull();
  });

  it('stores a valid IP as is', async () => {
    const { service, deps } = makeService();
    await service.register(registerDto, '2001:db8::1', 'jest');

    for (const ip of persistedIps(deps)) expect(ip).toBe('2001:db8::1');
  });
});

describe('AuthService.login password checks', () => {
  const password = 'Qwerty123';

  async function existingUser(): Promise<User> {
    const user = new User();
    user.id = 'user-1';
    user.email = 'known@test';
    user.password = await bcrypt.hash(password, 4);
    return user;
  }

  afterEach(() => jest.restoreAllMocks());

  it('runs bcrypt.compare exactly once for an existing user', async () => {
    const { service, deps } = makeService();
    deps.findUser.mockResolvedValue(await existingUser());
    const compare = jest.mocked(bcrypt.compare);
    compare.mockClear();

    await service.login({ email: 'known@test', password });

    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('runs bcrypt.compare exactly once for an unknown email', async () => {
    const { service } = makeService();
    const compare = jest.mocked(bcrypt.compare);
    compare.mockClear();

    await expect(
      service.login({ email: 'nobody@test', password }),
    ).rejects.toThrow(UnauthorizedException);
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown email and a wrong password identically', async () => {
    const { service, deps } = makeService();
    const unknown = service.login({ email: 'nobody@test', password });
    await expect(unknown).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );

    deps.findUser.mockResolvedValue(await existingUser());
    const wrong = service.login({ email: 'known@test', password: 'nope-123' });
    await expect(wrong).rejects.toThrow(
      new UnauthorizedException('Invalid credentials'),
    );
  });
});

describe('AuthService password hashing', () => {
  const password = 'Qwerty123';

  it('stores a bcrypt hash at the current cost on registration', async () => {
    const { service, deps } = makeService();
    await service.register(
      { email: 'hash@test', password, first_name: 'Hash' },
      '1.2.3.4',
      'jest',
    );

    const user = deps.persist.mock.calls
      .map(([entity]) => entity as unknown)
      .find((entity): entity is User => entity instanceof User);
    expect(user).toBeDefined();
    expect(user!.password).not.toBe(password);
    expect(bcrypt.getRounds(user!.password)).toBe(12);
    expect(await bcrypt.compare(password, user!.password)).toBe(true);
  });

  it('rehashes a legacy cost-10 hash on successful login', async () => {
    const { service, deps } = makeService();
    const user = new User();
    user.id = 'legacy-user';
    user.email = 'legacy@test';
    user.password = await bcrypt.hash(password, 10);
    deps.findUser.mockResolvedValue(user);

    await service.login({ email: 'legacy@test', password });

    expect(deps.updateUser).toHaveBeenCalledTimes(1);
    const [where, data] = deps.updateUser.mock.calls[0] as [
      unknown,
      { password: string },
    ];
    // Only the hash that was checked is replaced, so a password changed
    // meanwhile is not overwritten with the old one.
    expect(where).toEqual({ id: 'legacy-user', password: user.password });
    expect(bcrypt.getRounds(data.password)).toBe(12);
    expect(await bcrypt.compare(password, data.password)).toBe(true);
  });

  it('does not rehash after a failed login', async () => {
    const { service, deps } = makeService();
    const user = new User();
    user.id = 'legacy-user';
    user.email = 'legacy@test';
    user.password = await bcrypt.hash(password, 10);
    deps.findUser.mockResolvedValue(user);

    await expect(
      service.login({ email: 'legacy@test', password: 'wrong-pass' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('still logs in when the rehash cannot be saved', async () => {
    const { service, deps } = makeService();
    const user = new User();
    user.id = 'legacy-user';
    user.email = 'legacy@test';
    user.password = await bcrypt.hash(password, 10);
    deps.findUser.mockResolvedValue(user);
    deps.updateUser.mockRejectedValue(new Error('db down'));

    const tokens = await service.login({ email: 'legacy@test', password });
    expect(tokens.access_token).toBeDefined();
  });
});

describe('AuthService soft-deleted users', () => {
  it('looks up only users that are not soft-deleted on login', async () => {
    const { service, deps } = makeService();

    await expect(
      service.login({ email: 'gone@test', password: 'Qwerty123' }),
    ).rejects.toThrow(UnauthorizedException);

    expect(deps.findUser).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: null }),
      expect.anything(),
    );
  });
});

describe('AuthService.validateUser input types', () => {
  it.each([
    ['an operator object as email', { $like: 'a%' }, 'Qwerty123'],
    ['an operator object as password', 'known@test', { $ne: null }],
  ])('returns null without querying users for %s', async (_l, email, pwd) => {
    const { service, deps } = makeService();

    const result = await service.validateUser(
      email as unknown as string,
      pwd as unknown as string,
    );

    expect(result).toBeNull();
    expect(deps.findUser).not.toHaveBeenCalled();
  });
});

describe('AuthService REFRESH_REUSE_GRACE_SECONDS validation', () => {
  afterEach(() => {
    delete process.env.REFRESH_REUSE_GRACE_SECONDS;
  });

  // An invalid value must stop startup: read lazily, it would only fail on
  // the reuse path and skip the session revocation there.
  it('fails at module init on an invalid value', () => {
    process.env.REFRESH_REUSE_GRACE_SECONDS = '30s';
    const { service } = makeService();
    expect(() => service.onModuleInit()).toThrow('REFRESH_REUSE_GRACE_SECONDS');
  });

  it('accepts an unset value', () => {
    const { service } = makeService();
    expect(() => service.onModuleInit()).not.toThrow();
  });
});
/* eslint-enable @typescript-eslint/no-unsafe-return */
