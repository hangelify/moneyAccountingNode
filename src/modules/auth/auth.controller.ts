import {
  applyDecorators,
  BadRequestException,
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  Get,
  Header,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import {
  ClientTokenResponse,
  TokenResponseDto,
} from './dto/token-response.dto';
import { UserProfileDto } from '../user/dto/user-profile.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './types/jwt-payload.interface';
import { ClientMode, resolveClientMode } from './client-mode';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie';

// Swagger docs shared by every endpoint that issues or consumes a refresh token.
const ApiClientMode = () =>
  applyDecorators(
    ApiHeader({
      name: 'X-Client-Type',
      required: false,
      description:
        'Set to "mobile" (native apps only, request without Origin) to ' +
        'receive the refresh token in the body. Browsers omit it and get ' +
        'the refresh token as an HttpOnly cookie.',
    }),
    ApiResponse({
      status: 403,
      description:
        'Origin not allowed: web mode needs Origin = FRONTEND_URL or the ' +
        'API origin; mobile mode is rejected when Origin is present',
    }),
  );

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
  ) {}

  private extractIpAddress(req: Request): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  // Web clients get the refresh token only as an HttpOnly cookie; mobile
  // clients (no Origin, explicit header) keep receiving it in the body.
  private deliverTokens(
    mode: ClientMode,
    tokens: TokenResponseDto,
    res: Response,
  ): ClientTokenResponse {
    if (mode === 'mobile') {
      return tokens;
    }
    const { refresh_token: refreshToken, ...body } = tokens;
    setRefreshCookie(res, refreshToken);
    return body;
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({
    status: 201,
    description: 'User successfully registered',
    type: TokenResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - User already exists',
  })
  @ApiBody({ type: RegisterDto })
  @ApiClientMode()
  async register(
    @Body() registerDto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClientTokenResponse> {
    const mode = resolveClientMode(req);
    const ipAddress = this.extractIpAddress(req);
    const userAgent = req.get('user-agent');
    const tokens = await this.authService.register(
      registerDto,
      ipAddress,
      userAgent,
    );
    return this.deliverTokens(mode, tokens, res);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({
    status: 200,
    description: 'User successfully logged in',
    type: TokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiBody({ type: LoginDto })
  @ApiClientMode()
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClientTokenResponse> {
    const mode = resolveClientMode(req);
    const ipAddress = this.extractIpAddress(req);
    const userAgent = req.get('user-agent');
    const tokens = await this.authService.login(loginDto, ipAddress, userAgent);
    return this.deliverTokens(mode, tokens, res);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({
    status: 200,
    description: 'Token successfully refreshed',
    type: TokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiBody({ type: RefreshTokenDto, required: false })
  @ApiCookieAuth('refresh-cookie')
  @ApiClientMode()
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClientTokenResponse> {
    const mode = resolveClientMode(req);
    // Web mode never reads the body: the token must come from the cookie.
    const refreshToken =
      mode === 'web' ? readRefreshCookie(req) : refreshTokenDto.refresh_token;
    if (!refreshToken) {
      throw mode === 'web'
        ? new UnauthorizedException('Missing refresh token cookie')
        : new BadRequestException('refresh_token is required');
    }
    const ipAddress = this.extractIpAddress(req);
    const userAgent = req.get('user-agent');
    const tokens = await this.authService.refreshToken(
      refreshToken,
      ipAddress,
      userAgent,
    );
    return this.deliverTokens(mode, tokens, res);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({
    status: 200,
    description: 'User successfully logged out',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Logged out successfully' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiBody({ type: LogoutDto, required: false })
  @ApiClientMode()
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() logoutDto: LogoutDto = {},
  ): Promise<{ message: string }> {
    const mode = resolveClientMode(req);
    const refreshToken =
      mode === 'web' ? readRefreshCookie(req) : logoutDto.refresh_token;
    const ipAddress = this.extractIpAddress(req);
    const userAgent = req.get('user-agent');
    await this.authService.logout(
      user.id,
      user.sid,
      refreshToken,
      ipAddress,
      userAgent,
    );
    if (mode === 'web') {
      clearRefreshCookie(res);
    }
    return { message: 'Logged out successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'User profile retrieved successfully',
    type: UserProfileDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getProfile(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserProfileDto> {
    return this.userService.getProfile(user.id);
  }
}
