// Public API of the auth module.
// Other modules import from here, never from files inside the module.
// Order matters: leaf files first, the Nest module last, so a module that
// imports this barrel back during loading still finds the leaf exports.

export type {
  AuthenticatedUser,
  JwtPayload,
} from './types/jwt-payload.interface';
export { requireEnv } from './auth.env';
export { CurrentUser } from './decorators/current-user.decorator';
export { LoginDto } from './dto/login.dto';
export { RegisterDto } from './dto/register.dto';
export { TokenResponseDto } from './dto/token-response.dto';
export { JwtAuthGuard } from './guards/jwt-auth.guard';
export {
  InMemoryLoginAttemptStore,
  LOGIN_ATTEMPT_STORE,
  RedisLoginAttemptStore,
} from './login-lockout/login-attempt.store';
export type { LockoutPolicy } from './login-lockout/login-attempt.store';
export { AuthModule } from './auth.module';
