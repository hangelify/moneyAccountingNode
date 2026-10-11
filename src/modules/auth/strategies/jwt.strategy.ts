import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { User } from '../../../entities/user.entity';
import { Session } from '../../../entities/session.entity';
import { JwtPayload, AuthenticatedUser } from '../types/jwt-payload.interface';
import { requireEnv } from '../auth.env';
import {
  ACCESS_TOKEN_TYP,
  JWT_ALGORITHM,
  hasTyp,
  jwtAudience,
  jwtIssuer,
} from '../token-format';

const LAST_ACTIVITY_WRITE_THROTTLE_MS = 60_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(Session)
    private readonly sessionRepository: EntityRepository<Session>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('JWT_SECRET'),
      algorithms: [JWT_ALGORITHM],
      issuer: jwtIssuer(),
      audience: jwtAudience(),
      // The header is needed to check typ, which jsonwebtoken does not.
      jsonWebTokenOptions: { complete: true },
    });
  }

  async validate({
    header,
    payload,
  }: {
    header: { typ?: string };
    payload: JwtPayload;
  }): Promise<AuthenticatedUser> {
    if (
      !hasTyp(header.typ, ACCESS_TOKEN_TYP) ||
      !payload.sub ||
      payload.type !== 'access' ||
      !payload.sid
    ) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const user = await this.userRepository.findOne(
      { id: payload.sub, deleted_at: null },
      {
        fields: [
          'id',
          'email',
          'first_name',
          'last_name',
          'username',
          'currency',
          'language_code',
        ],
      },
    );

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const session = await this.sessionRepository.findOne({
      id: payload.sid,
      user: { id: payload.sub },
      is_active: true,
    });

    if (!session) {
      throw new UnauthorizedException('Session not found or revoked');
    }

    const now = new Date();
    if (now > session.absolute_expires_at) {
      await this.sessionRepository.nativeUpdate(
        { id: session.id },
        { is_active: false },
      );
      throw new UnauthorizedException('Session has expired');
    }

    const lastActivity = session.last_activity_at?.getTime() ?? 0;
    if (now.getTime() - lastActivity > LAST_ACTIVITY_WRITE_THROTTLE_MS) {
      await this.sessionRepository.nativeUpdate(
        { id: session.id },
        { last_activity_at: now },
      );
    }

    return { ...(user as Omit<AuthenticatedUser, 'sid'>), sid: session.id };
  }
}
