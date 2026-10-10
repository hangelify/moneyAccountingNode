import {
  Injectable,
  UnauthorizedException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { createHash, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PASSWORD_HASH_ROUNDS, User } from '../../entities/user.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Session } from '../../entities/session.entity';
import { Log, LogLevel, LogSource } from '../../entities/log.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { Currency } from '../../types/currency.enum';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { JwtPayload } from './types/jwt-payload.interface';
import { requireEnv, requireIntEnv } from './auth.env';
import { CategoryDefaultsService } from '../category/category-defaults.service';
import { sanitizeIp } from '../../common/utils/ip.util';

// Compared against when the email is unknown, so that path costs one bcrypt
// round like a real password check and does not reveal which emails exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(randomUUID(), PASSWORD_HASH_ROUNDS);

interface IssuedTokens {
  tokens: TokenResponseDto;
  session: Session;
  refreshJti: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: EntityRepository<RefreshToken>,
    @InjectRepository(Session)
    private readonly sessionRepository: EntityRepository<Session>,
    @InjectRepository(Log)
    private readonly logRepository: EntityRepository<Log>,
    private readonly em: EntityManager,
    private readonly jwtService: JwtService,
    private readonly categoryDefaults: CategoryDefaultsService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    // Callers may pass a raw request body; a non-string here would turn into
    // a MikroORM operator query ({ $like: ... }).
    if (typeof email !== 'string' || typeof password !== 'string') {
      return null;
    }

    const user = await this.userRepository.findOne(
      { email },
      {
        fields: [
          'id',
          'email',
          'first_name',
          'last_name',
          'username',
          'password',
          'currency',
          'language_code',
        ],
      },
    );

    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      await this.logAuthAttempt(email, false, 'User not found');
      return null;
    }

    const isPasswordValid = await user.validatePassword(password);
    if (!isPasswordValid) {
      await this.logAuthAttempt(email, false, 'Invalid password');
      return null;
    }

    return user as User;
  }

  async login(
    loginDto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenResponseDto> {
    const user = await this.validateUser(loginDto.email, loginDto.password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const issued = await this.startSession(user, ipAddress, userAgent);
    await this.logAuthAttempt(
      loginDto.email,
      true,
      'Login successful',
      ipAddress,
      userAgent,
    );

    this.logger.log(`User logged in: ${user.email}`);
    return issued.tokens;
  }

  async register(
    registerDto: RegisterDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenResponseDto> {
    const existingUser = await this.userRepository.findOne({
      email: registerDto.email,
    });

    if (existingUser) {
      await this.logAuthAttempt(
        registerDto.email,
        false,
        'Registration failed - user already exists',
        ipAddress,
        userAgent,
      );
      throw new BadRequestException('User already exists');
    }

    const user = new User();
    user.email = registerDto.email;
    user.password = registerDto.password;
    user.first_name = registerDto.first_name;
    user.last_name = registerDto.last_name;
    user.username = registerDto.username;
    user.currency = Currency.EUR;

    const household = new Household();
    household.name = 'Personal';
    household.created_by = user;

    const membership = new HouseholdMember();
    membership.household = household;
    membership.user = user;
    membership.role = 'owner';

    await this.em.transactional((txEm) => {
      txEm.persist(user);
      txEm.persist(household);
      txEm.persist(membership);
      return Promise.resolve();
    });

    try {
      await this.categoryDefaults.seedForHousehold(household.id);
    } catch (err) {
      this.logger.error(
        `Failed to seed default categories for user ${user.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue — user can invoke POST /households/:hid/categories/seed-defaults to backfill.
    }

    const issued = await this.startSession(user, ipAddress, userAgent);
    await this.logAuthAttempt(
      registerDto.email,
      true,
      'Registration successful',
      ipAddress,
      userAgent,
    );

    return issued.tokens;
  }

  async refreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenResponseDto> {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: requireEnv('JWT_REFRESH_SECRET'),
      });
    } catch {
      await this.logAuthAttempt(
        'unknown',
        false,
        'Token refresh failed - signature invalid or expired',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh') {
      await this.logAuthAttempt(
        payload.email ?? 'unknown',
        false,
        'Token refresh failed - wrong token type',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(refreshToken);

    const tokenEntity = await this.refreshTokenRepository.findOne(
      { token_hash: tokenHash },
      { populate: ['session', 'user'] },
    );

    if (!tokenEntity) {
      await this.logAuthAttempt(
        payload.email ?? 'unknown',
        false,
        'Token refresh failed - token not recognized',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenEntity.is_revoked) {
      this.logger.warn(
        `Refresh token reuse detected for session ${tokenEntity.session.id}`,
      );
      await this.revokeSession(tokenEntity.session.id);
      await this.logAuthAttempt(
        tokenEntity.user.email,
        false,
        'Token refresh failed - reuse detected, session revoked',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    const session = tokenEntity.session;

    if (!session.is_active) {
      throw new UnauthorizedException('Session is no longer active');
    }

    const now = new Date();
    if (now > session.absolute_expires_at) {
      await this.revokeSession(session.id);
      throw new UnauthorizedException('Session has expired');
    }

    if (now > tokenEntity.expires_at) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const rowsRevoked = await this.refreshTokenRepository.nativeUpdate(
      { id: tokenEntity.id, is_revoked: false },
      { is_revoked: true },
    );

    if (rowsRevoked === 0) {
      throw new UnauthorizedException('Refresh token already used');
    }

    this.em.clear();

    const user = await this.userRepository.findOneOrFail({
      id: tokenEntity.user.id,
    });
    const freshSession = await this.sessionRepository.findOneOrFail({
      id: session.id,
    });

    freshSession.last_activity_at = now;
    const sanitizedIp = sanitizeIp(ipAddress);
    if (sanitizedIp) freshSession.ip_address = sanitizedIp;
    if (userAgent) freshSession.user_agent = userAgent;

    const issued = await this.issueTokensForSession(
      user,
      freshSession,
      ipAddress,
      userAgent,
    );

    await this.em.flush();

    await this.logAuthAttempt(
      user.email,
      true,
      'Token refreshed',
      ipAddress,
      userAgent,
    );

    return issued.tokens;
  }

  async logout(
    userId: string,
    sid: string,
    refreshToken?: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    let targetSessionId = sid;

    if (refreshToken) {
      const hash = this.hashToken(refreshToken);
      const tokenEntity = await this.refreshTokenRepository.findOne(
        { token_hash: hash },
        { populate: ['session'] },
      );
      if (tokenEntity && tokenEntity.user.id === userId) {
        targetSessionId = tokenEntity.session.id;
      }
    }

    await this.revokeSession(targetSessionId);

    const user = await this.userRepository.findOne({ id: userId });
    if (user) {
      await this.logAuthAttempt(
        user.email,
        true,
        'User logged out',
        ipAddress,
        userAgent,
      );
    }
  }

  private async startSession(
    user: User,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<IssuedTokens> {
    const sessionLifetimeMs = requireIntEnv('JWT_REFRESH_EXPIRES_IN_MS');
    const now = new Date();

    const session = this.sessionRepository.create({
      user,
      ip_address: sanitizeIp(ipAddress),
      user_agent: userAgent,
      created_at: now,
      absolute_expires_at: new Date(now.getTime() + sessionLifetimeMs),
      last_activity_at: now,
      is_active: true,
    });

    await this.em.persist(session).flush();

    const issued = await this.issueTokensForSession(
      user,
      session,
      ipAddress,
      userAgent,
    );
    await this.em.flush();
    return issued;
  }

  private async issueTokensForSession(
    user: User,
    session: Session,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<IssuedTokens> {
    const accessTokenExpiresInMs = requireIntEnv('JWT_EXPIRES_IN_MS');
    const refreshTokenExpiresInMs = requireIntEnv('JWT_REFRESH_EXPIRES_IN_MS');

    const accessTokenExpiresInSeconds = Math.floor(
      accessTokenExpiresInMs / 1000,
    );
    const refreshTokenExpiresInSeconds = Math.floor(
      refreshTokenExpiresInMs / 1000,
    );

    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      first_name: user.first_name,
      type: 'access',
      jti: accessJti,
      sid: session.id,
    };

    const refreshPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      first_name: user.first_name,
      type: 'refresh',
      jti: refreshJti,
      sid: session.id,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: requireEnv('JWT_SECRET'),
        expiresIn: accessTokenExpiresInSeconds,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: requireEnv('JWT_REFRESH_SECRET'),
        expiresIn: refreshTokenExpiresInSeconds,
      }),
    ]);

    const refreshExpiresAt = new Date(Date.now() + refreshTokenExpiresInMs);
    const refreshTokenHash = this.hashToken(refreshToken);

    const refreshRow = this.refreshTokenRepository.create({
      user,
      session,
      token_hash: refreshTokenHash,
      jti: refreshJti,
      ip_address: sanitizeIp(ipAddress),
      user_agent: userAgent,
      created_at: new Date(),
      expires_at: refreshExpiresAt,
      is_revoked: false,
    });

    this.em.persist(refreshRow);

    return {
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: accessTokenExpiresInSeconds,
        token_type: 'Bearer',
      },
      session,
      refreshJti,
      refreshTokenHash,
      refreshExpiresAt,
    };
  }

  private async revokeSession(sessionId: string): Promise<void> {
    await this.sessionRepository.nativeUpdate(
      { id: sessionId },
      { is_active: false },
    );
    await this.refreshTokenRepository.nativeUpdate(
      { session: { id: sessionId }, is_revoked: false },
      { is_revoked: true },
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async logAuthAttempt(
    email: string,
    success: boolean,
    message: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const log = this.logRepository.create({
      level: success ? LogLevel.INFO : LogLevel.WARN,
      source: LogSource.AUTH,
      context: 'Authentication',
      message: `Auth attempt: ${message} - ${email}`,
      metadata: { email, success },
      ip_address: sanitizeIp(ipAddress),
      user_agent: userAgent,
      created_at: new Date(),
    });

    await this.em.persist(log).flush();
  }
}
