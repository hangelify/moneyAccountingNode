import { User } from '../../../entities/user.entity';

export type TokenType = 'access' | 'refresh';

// No personal data: the claims are readable by anyone holding the token.
export interface JwtPayload {
  sub: string;
  type: TokenType;
  jti: string;
  sid?: string;
  iat?: number;
  exp?: number;
}

export type AuthenticatedUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'first_name'
  | 'last_name'
  | 'username'
  | 'currency'
  | 'language_code'
> & { sid: string };
