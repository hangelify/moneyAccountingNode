import {
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt } from 'passport-jwt';
import { HttpExceptionWithHeaders } from '../../../common/exceptions/http-exception-with-headers';
import { ALLOW_UNVERIFIED_KEY } from '../decorators/allow-unverified.decorator';

const REALM = 'api';
const extractToken = ExtractJwt.fromAuthHeaderAsBearerToken();

// Refusals carry a Bearer challenge (RFC 6750 §3): bare when the request
// had no token, with error="invalid_token" when the token was refused.
// An authenticated user with an unverified email gets 403 unless the route
// carries @AllowUnverified(): closed by default.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  handleRequest<TUser>(
    err: Error | null | undefined,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (user && !err) {
      this.assertEmailVerified(user, context);
      return user;
    }
    // Anything but a refusal (e.g. the database being down) is not a 401.
    if (err && !(err instanceof UnauthorizedException)) {
      throw err;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const challenge = extractToken(req)
      ? `Bearer realm="${REALM}", error="invalid_token"`
      : `Bearer realm="${REALM}"`;
    const refusal =
      err instanceof UnauthorizedException ? err : new UnauthorizedException();

    throw new HttpExceptionWithHeaders(
      refusal.getResponse() as string | Record<string, unknown>,
      HttpStatus.UNAUTHORIZED,
      { 'WWW-Authenticate': challenge },
    );
  }

  private assertEmailVerified(user: unknown, context: ExecutionContext): void {
    const open = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_UNVERIFIED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (
      open ||
      (user as { email_verified_at?: Date | null }).email_verified_at
    ) {
      return;
    }
    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: 'email_not_verified',
      message: 'Email address is not verified',
    });
  }
}
