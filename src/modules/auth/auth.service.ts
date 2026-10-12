import {
  HttpException,
  Injectable,
  UnauthorizedException,
  Logger,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@mikro-orm/nestjs';
import {
  EntityRepository,
  EntityManager,
  QueryOrder,
  sql,
} from '@mikro-orm/core';
import { createHash, randomUUID } from 'crypto';
import { User } from '../../entities/user.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Session } from '../../entities/session.entity';
import { Log, LogLevel, LogSource } from '../../entities/log.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { Currency } from '../../types/currency.enum';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { SessionDto } from './dto/session.dto';
import { AuthenticatedUser, JwtPayload } from './types/jwt-payload.interface';
import {
  ACCESS_TOKEN_TYP,
  JWT_ALGORITHM,
  REFRESH_TOKEN_TYP,
  hasTyp,
  jwtAudience,
  jwtIssuer,
} from './token-format';
import {
  optionalNonNegativeIntEnv,
  requireEnv,
  requireIntEnv,
} from './auth.env';
import { CategoryDefaultsService } from '../category/category-defaults.service';
import { sanitizeIp } from '../../common/utils/ip.util';
import { normalizeEmail } from '../../common/transforms/normalize-email';
import { PasswordService } from './password.service';
import { maskEmail } from '../../common/utils/mask-email';
import { LoginLockoutService } from './login-lockout/login-lockout.service';
import { EmailVerificationService } from './email-verification/email-verification.service';

// Whom an audit entry is about: a known user, or the email as typed.
type AuthSubject = { userId: string } | { email: string } | null;

interface IssuedTokens {
  tokens: TokenResponseDto;
  session: Session;
  refreshJti: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService implements OnModuleInit {
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
    private readonly passwordService: PasswordService,
    private readonly loginLockout: LoginLockoutService,
    private readonly emailVerification: EmailVerificationService,
  ) {}

  // Read lazily, an invalid value would only surface on the reuse path and
  // skip the session revocation there; fail at startup instead.
  onModuleInit(): void {
    this.reuseGraceSeconds();
  }

  async validateUser(
    email: string,
    password: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<User | null> {
    // Callers may pass a raw request body; a non-string here would turn into
    // a MikroORM operator query ({ $like: ... }).
    if (typeof email !== 'string' || typeof password !== 'string') {
      return null;
    }

    const user = await this.userRepository.findOne(
      // lower(email) matches the users_email_lower_unique index.
      { [sql.lower('email')]: normalizeEmail(email), deleted_at: null },
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
      await this.passwordService.verifyAgainstDummy(password);
      await this.logAuthAttempt(
        { email },
        false,
        'User not found',
        ipAddress,
        userAgent,
      );
      return null;
    }

    const check = await this.passwordService.verify(password, user.password);
    if (!check.valid) {
      await this.logAuthAttempt(
        { userId: user.id },
        false,
        'Invalid password',
        ipAddress,
        userAgent,
      );
      return null;
    }

    if (check.needsRehash) {
      await this.rehashPassword(user.id, user.password, password);
    }

    return user as User;
  }

  // Upgrades a hash made at a lower cost. Only the hash that was checked is
  // replaced, so a password changed in the meantime is not overwritten with
  // the old one. Best effort: the user has already proven the password, so a
  // failed write must not fail the login.
  private async rehashPassword(
    userId: string,
    checkedHash: string,
    password: string,
  ): Promise<void> {
    try {
      await this.userRepository.nativeUpdate(
        { id: userId, password: checkedHash },
        { password: await this.passwordService.hash(password) },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to rehash password for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async login(
    loginDto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenResponseDto> {
    // Counted before the password is checked, so a locked account does not
    // confirm a correct guess and parallel guesses cannot outrun the lock.
    try {
      await this.loginLockout.reserveAttempt(loginDto.email);
    } catch (err) {
      if (err instanceof HttpException) {
        await this.logAuthAttempt(
          { email: loginDto.email },
          false,
          'Login blocked - too many failed attempts',
          ipAddress,
          userAgent,
        );
      }
      throw err;
    }

    const user = await this.validateUser(
      loginDto.email,
      loginDto.password,
      ipAddress,
      userAgent,
    );

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.loginLockout.reset(loginDto.email);
    const issued = await this.startSession(user, ipAddress, userAgent);
    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'Login successful',
      ipAddress,
      userAgent,
    );

    this.logger.log(`User logged in: ${user.id}`);
    return issued.tokens;
  }

  async register(
    registerDto: RegisterDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenResponseDto> {
    const existingUser = await this.userRepository.findOne({
      [sql.lower('email')]: normalizeEmail(registerDto.email),
    });

    if (existingUser) {
      await this.logAuthAttempt(
        { userId: existingUser.id },
        false,
        'Registration failed - user already exists',
        ipAddress,
        userAgent,
      );
      // Deliberately explicit: this reveals that the email is registered, an
      // accepted UX trade-off. Registration stays behind the IP rate limit; a
      // generic reply would need a "someone tried to sign up" email first.
      throw new BadRequestException('User already exists');
    }

    const user = new User();
    user.email = normalizeEmail(registerDto.email);
    user.password = await this.passwordService.hash(registerDto.password);
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

    // Never fails registration: the user can ask for another email.
    await this.emailVerification.issueAndSend(user);

    const issued = await this.startSession(user, ipAddress, userAgent);
    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'Registration successful',
      ipAddress,
      userAgent,
    );

    return issued.tokens;
  }

  async verifyEmail(
    token: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    let userId: string;
    try {
      userId = await this.emailVerification.verify(token);
    } catch (err) {
      await this.logAuthAttempt(
        null,
        false,
        'Email verification failed - invalid or expired token',
        ipAddress,
        userAgent,
      );
      throw err;
    }
    await this.logAuthAttempt(
      { userId },
      true,
      'Email verified',
      ipAddress,
      userAgent,
    );
  }

  async resendVerification(
    user: AuthenticatedUser,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const result = await this.emailVerification.resend(user.id);
    if (result === 'sent') {
      await this.logAuthAttempt(
        { userId: user.id },
        true,
        'Verification email resent',
        ipAddress,
        userAgent,
      );
    }
  }

  async refreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenResponseDto> {
    let payload: JwtPayload;
    try {
      const decoded = this.jwtService.verify<{
        header: { typ?: string };
        payload: JwtPayload;
      }>(refreshToken, {
        secret: requireEnv('JWT_REFRESH_SECRET'),
        algorithms: [JWT_ALGORITHM],
        issuer: jwtIssuer(),
        audience: jwtAudience(),
        complete: true,
      });
      if (!hasTyp(decoded.header.typ, REFRESH_TOKEN_TYP)) {
        throw new Error('Unexpected token typ');
      }
      payload = decoded.payload;
    } catch {
      await this.logAuthAttempt(
        null,
        false,
        'Token refresh failed - signature invalid or expired',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.type !== 'refresh') {
      await this.logAuthAttempt(
        { userId: payload.sub },
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
        { userId: payload.sub },
        false,
        'Token refresh failed - token not recognized',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenEntity.user.deleted_at) {
      await this.revokeSession(tokenEntity.session.id);
      await this.logAuthAttempt(
        { userId: tokenEntity.user.id },
        false,
        'Token refresh failed - user deleted, session revoked',
        ipAddress,
        userAgent,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (tokenEntity.is_revoked) {
      // A client retrying after a lost response presents the token it just
      // rotated. Inside the grace window that is refused without treating it
      // as theft; the session and the newly issued pair stay valid.
      if (this.isWithinReuseGrace(tokenEntity.revoked_at)) {
        await this.logAuthAttempt(
          { userId: tokenEntity.user.id },
          false,
          'Token refresh failed - token already rotated, within reuse grace window',
          ipAddress,
          userAgent,
        );
        throw new UnauthorizedException('Refresh token already used');
      }

      this.logger.warn(
        `Refresh token reuse detected for session ${tokenEntity.session.id}`,
      );
      await this.revokeSession(tokenEntity.session.id);
      await this.logAuthAttempt(
        { userId: tokenEntity.user.id },
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

    // Revocation and the new pair commit together: if issuing fails, the old
    // token stays valid and the client's retry is not taken for a reuse.
    // The conditional UPDATE locks the row, so a concurrent refresh with the
    // same token that already passed the checks above waits for this
    // transaction and then matches no row (401). One that reads the token
    // after the commit takes the reuse path instead.
    const { issued, user } = await this.em.transactional(
      async (txEm) => {
        const rowsRevoked = await txEm.nativeUpdate(
          RefreshToken,
          { id: tokenEntity.id, is_revoked: false },
          { is_revoked: true, revoked_at: now },
        );

        if (rowsRevoked === 0) {
          throw new UnauthorizedException('Refresh token already used');
        }

        const user = await txEm.findOne(User, {
          id: tokenEntity.user.id,
          deleted_at: null,
        });
        if (!user) {
          throw new UnauthorizedException('Invalid refresh token');
        }
        const freshSession = await txEm.findOneOrFail(Session, {
          id: session.id,
        });

        freshSession.last_activity_at = now;
        const sanitizedIp = sanitizeIp(ipAddress);
        if (sanitizedIp) freshSession.ip_address = sanitizedIp;
        if (userAgent) freshSession.user_agent = userAgent;

        const issued = await this.issueTokensForSession(
          txEm,
          user,
          freshSession,
          ipAddress,
          userAgent,
        );
        return { issued, user };
      },
      { clear: true },
    );

    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'Token refreshed',
      ipAddress,
      userAgent,
    );

    return issued.tokens;
  }

  // RFC 7009: the token itself is the credential, and an unknown or already
  // revoked token is not an error for the caller. Expired and rotated tokens
  // still identify their session, so they end it too.
  async revokeRefreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const tokenEntity = await this.refreshTokenRepository.findOne(
      { token_hash: this.hashToken(refreshToken) },
      { populate: ['user'] },
    );

    if (!tokenEntity) {
      await this.logAuthAttempt(
        null,
        false,
        'Token revocation - token not recognized',
        ipAddress,
        userAgent,
      );
      return;
    }

    await this.revokeSession(tokenEntity.session.id);
    await this.logAuthAttempt(
      { userId: tokenEntity.user.id },
      true,
      'Session revoked by refresh token',
      ipAddress,
      userAgent,
      { session_id: tokenEntity.session.id },
    );
  }

  async logout(
    user: AuthenticatedUser,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    await this.revokeSession(user.sid);
    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'User logged out',
      ipAddress,
      userAgent,
      { session_id: user.sid },
    );
  }

  async logoutAll(
    user: AuthenticatedUser,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const now = new Date();
    // Tokens before sessions: refresh locks a token row and then the session
    // row, so the same order here cannot deadlock against it.
    const revokedSessions = await this.em.transactional(async (txEm) => {
      await txEm.nativeUpdate(
        RefreshToken,
        { user: { id: user.id }, is_revoked: false },
        { is_revoked: true, revoked_at: now },
      );
      return txEm.nativeUpdate(
        Session,
        { user: { id: user.id }, is_active: true },
        { is_active: false },
      );
    });

    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'User logged out of all sessions',
      ipAddress,
      userAgent,
      { revoked_sessions: revokedSessions },
    );
  }

  // The current session stays; every other one ends, so a device that knew
  // the old password (or a stolen token) loses access.
  async changePassword(
    user: AuthenticatedUser,
    dto: ChangePasswordDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const stored = await this.userRepository.findOne(
      { id: user.id, deleted_at: null },
      { fields: ['id', 'password'] },
    );
    if (!stored) {
      throw new UnauthorizedException('User not found');
    }

    const check = await this.passwordService.verify(
      dto.current_password,
      stored.password,
    );
    if (!check.valid) {
      await this.logAuthAttempt(
        { userId: user.id },
        false,
        'Password change failed - wrong current password',
        ipAddress,
        userAgent,
        { session_id: user.sid },
      );
      throw new BadRequestException('Current password is incorrect');
    }

    const newHash = await this.passwordService.hash(dto.new_password);
    const now = new Date();
    // Tokens before sessions, in the lock order of refresh (see logoutAll).
    const revokedSessions = await this.em.transactional(async (txEm) => {
      await txEm.nativeUpdate(
        User,
        { id: user.id },
        { password: newHash, updated_at: now },
      );
      await txEm.nativeUpdate(
        RefreshToken,
        {
          user: { id: user.id },
          session: { $ne: user.sid },
          is_revoked: false,
        },
        { is_revoked: true, revoked_at: now },
      );
      return txEm.nativeUpdate(
        Session,
        { user: { id: user.id }, id: { $ne: user.sid }, is_active: true },
        { is_active: false },
      );
    });

    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'Password changed, other sessions revoked',
      ipAddress,
      userAgent,
      { session_id: user.sid, revoked_sessions: revokedSessions },
    );
  }

  async listSessions(user: AuthenticatedUser): Promise<SessionDto[]> {
    const sessions = await this.sessionRepository.find(
      {
        user: { id: user.id },
        is_active: true,
        absolute_expires_at: { $gt: new Date() },
      },
      {
        orderBy: {
          last_activity_at: QueryOrder.DESC_NULLS_LAST,
          created_at: QueryOrder.DESC,
        },
      },
    );

    return sessions.map((session) => ({
      id: session.id,
      created_at: session.created_at,
      last_activity_at: session.last_activity_at ?? null,
      ip: session.ip_address ?? null,
      user_agent: session.user_agent ?? null,
      current: session.id === user.sid,
    }));
  }

  // Only an active session of the user counts; anything else is a 404, so
  // the endpoint does not reveal which session ids exist.
  async revokeOwnSession(
    user: AuthenticatedUser,
    sessionId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const ended = await this.sessionRepository.nativeUpdate(
      { id: sessionId, user: { id: user.id }, is_active: true },
      { is_active: false },
    );
    if (ended === 0) {
      throw new NotFoundException('Session not found');
    }
    await this.refreshTokenRepository.nativeUpdate(
      { session: { id: sessionId }, is_revoked: false },
      { is_revoked: true, revoked_at: new Date() },
    );

    await this.logAuthAttempt(
      { userId: user.id },
      true,
      'Session revoked by user',
      ipAddress,
      userAgent,
      { session_id: sessionId },
    );
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
      this.em,
      user,
      session,
      ipAddress,
      userAgent,
    );
    await this.em.flush();
    return issued;
  }

  // Persists the new refresh row into `em` without flushing.
  private async issueTokensForSession(
    em: EntityManager,
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
      type: 'access',
      jti: accessJti,
      sid: session.id,
    };

    const refreshPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      type: 'refresh',
      jti: refreshJti,
      sid: session.id,
    };

    const signOptions = {
      algorithm: JWT_ALGORITHM,
      issuer: jwtIssuer(),
      audience: jwtAudience(),
    } as const;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        ...signOptions,
        secret: requireEnv('JWT_SECRET'),
        expiresIn: accessTokenExpiresInSeconds,
        header: { alg: JWT_ALGORITHM, typ: ACCESS_TOKEN_TYP },
      }),
      this.jwtService.signAsync(refreshPayload, {
        ...signOptions,
        secret: requireEnv('JWT_REFRESH_SECRET'),
        expiresIn: refreshTokenExpiresInSeconds,
        header: { alg: JWT_ALGORITHM, typ: REFRESH_TOKEN_TYP },
      }),
    ]);

    const refreshExpiresAt = new Date(Date.now() + refreshTokenExpiresInMs);
    const refreshTokenHash = this.hashToken(refreshToken);

    const refreshRow = em.create(RefreshToken, {
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

    em.persist(refreshRow);

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
      { is_revoked: true, revoked_at: new Date() },
    );
  }

  private reuseGraceSeconds(): number {
    return optionalNonNegativeIntEnv('REFRESH_REUSE_GRACE_SECONDS', 0);
  }

  private isWithinReuseGrace(revokedAt: Date | null | undefined): boolean {
    const graceSeconds = this.reuseGraceSeconds();
    if (graceSeconds === 0 || !revokedAt) {
      return false;
    }
    return Date.now() - revokedAt.getTime() <= graceSeconds * 1000;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // The raw email is never written: it may be an address typed by an attacker.
  private async logAuthAttempt(
    subject: AuthSubject,
    success: boolean,
    message: string,
    ipAddress?: string,
    userAgent?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    let who = 'unknown';
    let identity: Record<string, string> = {};
    if (subject && 'userId' in subject) {
      who = `user:${subject.userId}`;
      identity = { user_id: subject.userId };
    } else if (subject) {
      who = maskEmail(subject.email);
      identity = { email_masked: who };
    }

    const log = this.logRepository.create({
      level: success ? LogLevel.INFO : LogLevel.WARN,
      source: LogSource.AUTH,
      context: 'Authentication',
      message: `Auth attempt: ${message} - ${who}`,
      metadata: { ...details, ...identity, success },
      ip_address: sanitizeIp(ipAddress),
      user_agent: userAgent,
      created_at: new Date(),
    });

    await this.em.persist(log).flush();
  }
}
