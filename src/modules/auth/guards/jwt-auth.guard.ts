import {
  ExecutionContext,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt } from 'passport-jwt';
import { HttpExceptionWithHeaders } from '../../../common/exceptions/http-exception-with-headers';

const REALM = 'api';
const extractToken = ExtractJwt.fromAuthHeaderAsBearerToken();

// Refusals carry a Bearer challenge (RFC 6750 §3): bare when the request
// had no token, with error="invalid_token" when the token was refused.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(
    err: Error | null | undefined,
    user: TUser | false,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (user && !err) {
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
}
