# React App Setup with OAuth2 Authentication

## Overview

This document provides a comprehensive guide for:
1. Setting up a React application
2. Implementing OAuth2 authentication with token refresh
3. Setting up logging on both frontend and backend
4. Integrating React frontend with NestJS backend

---

## Part 1: React Application Setup

### 1.1 Create React Application

#### Option A: Vite (Recommended - Faster, Modern)

```bash
# Create React app with Vite
npm create vite@latest accounting-frontend -- --template react-ts

cd accounting-frontend
npm install

# Install additional dependencies
npm install axios react-router-dom @tanstack/react-query
npm install -D @types/node
```

#### Option B: Create React App (CRA)

```bash
npx create-react-app accounting-frontend --template typescript
cd accounting-frontend
npm install axios react-router-dom @tanstack/react-query
```

### 1.2 Project Structure

```
accounting-frontend/
├── public/
├── src/
│   ├── api/              # API client configuration
│   │   ├── client.ts     # Axios instance with interceptors
│   │   ├── auth.api.ts   # Authentication endpoints
│   │   └── types.ts      # API types
│   ├── auth/             # Authentication logic
│   │   ├── AuthContext.tsx
│   │   ├── AuthProvider.tsx
│   │   ├── useAuth.ts
│   │   └── tokenManager.ts
│   ├── components/       # React components
│   ├── pages/            # Page components
│   ├── hooks/            # Custom hooks
│   ├── utils/            # Utility functions
│   │   └── logger.ts     # Frontend logging
│   ├── config/           # Configuration
│   │   └── env.ts
│   ├── App.tsx
│   └── main.tsx
├── .env
├── .env.production
├── package.json
└── vite.config.ts (or tsconfig.json for CRA)
```

### 1.3 Environment Configuration

Create `.env` files:

**.env (Development)**
```env
VITE_API_URL=http://localhost:3000
VITE_APP_NAME=Accounting App
VITE_LOG_LEVEL=debug
```

**.env.production**
```env
VITE_API_URL=https://api.yourdomain.com
VITE_APP_NAME=Accounting App
VITE_LOG_LEVEL=error
```

**src/config/env.ts**
```typescript
export const config = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  appName: import.meta.env.VITE_APP_NAME || 'Accounting App',
  logLevel: import.meta.env.VITE_LOG_LEVEL || 'info',
} as const;
```

---

## Part 2: OAuth2 Implementation

### 2.1 Backend: NestJS OAuth2 Setup

#### Install Required Packages

```bash
cd accounting-backend
npm install @nestjs/jwt @nestjs/passport passport passport-jwt passport-local bcrypt
npm install -D @types/passport-jwt @types/passport-local @types/bcrypt
```

#### Create Auth Module Structure

```
src/
├── modules/
│   └── auth/
│       ├── auth.module.ts
│       ├── auth.controller.ts
│       ├── auth.service.ts
│       ├── strategies/
│       │   ├── jwt.strategy.ts
│       │   └── local.strategy.ts
│       ├── guards/
│       │   ├── jwt-auth.guard.ts
│       │   └── local-auth.guard.ts
│       ├── decorators/
│       │   └── current-user.decorator.ts
│       └── dto/
│           ├── login.dto.ts
│           ├── register.dto.ts
│           └── token-response.dto.ts
```

#### Update User Entity

**src/entities/user.entity.ts**
```typescript
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Currency } from '../types/currency.enum';
import { LanguageCode } from '../types/language-code.enum';
import * as bcrypt from 'bcrypt';

@Entity({ tableName: 'users' })
export class User extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  first_name!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  last_name?: string;

  @Property({ type: 'varchar', length: 255, nullable: false, unique: true })
  email!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  username?: string;

  @Property({ type: 'varchar', length: 255, nullable: false })
  password!: string; // Hashed password

  @Enum({
    items: () => LanguageCode,
    type: 'enum',
    nativeEnumName: 'language_code_enum',
    nullable: true,
  })
  language_code?: LanguageCode;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: false,
    default: Currency.EUR,
  })
  currency!: Currency;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @BeforeCreate()
  async beforeCreate() {
    this.created_at = new Date();
    this.updated_at = new Date();
    if (this.password) {
      this.password = await bcrypt.hash(this.password, 10);
    }
  }

  @BeforeUpdate()
  beforeUpdate() {
    this.updated_at = new Date();
  }

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }
}
```

#### Auth Service

**src/modules/auth/auth.service.ts**
```typescript
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { User } from '../../entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenResponseDto } from './dto/token-response.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    this.logger.debug(`Validating user: ${email}`);
    
    const user = await this.userRepository.findOne({ email });
    if (!user) {
      this.logger.warn(`User not found: ${email}`);
      return null;
    }

    const isPasswordValid = await user.validatePassword(password);
    if (!isPasswordValid) {
      this.logger.warn(`Invalid password for user: ${email}`);
      return null;
    }

    this.logger.log(`User validated successfully: ${email}`);
    return user;
  }

  async login(loginDto: LoginDto): Promise<TokenResponseDto> {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    
    if (!user) {
      this.logger.warn(`Login failed for: ${loginDto.email}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user);
    this.logger.log(`User logged in successfully: ${user.email}`);
    
    return tokens;
  }

  async register(registerDto: RegisterDto): Promise<TokenResponseDto> {
    this.logger.debug(`Registering new user: ${registerDto.email}`);

    const existingUser = await this.userRepository.findOne({
      email: registerDto.email,
    });

    if (existingUser) {
      this.logger.warn(`Registration failed - user exists: ${registerDto.email}`);
      throw new UnauthorizedException('User already exists');
    }

    const user = this.userRepository.create({
      email: registerDto.email,
      password: registerDto.password,
      first_name: registerDto.first_name,
      last_name: registerDto.last_name,
      username: registerDto.username,
    });

    await this.userRepository.persistAndFlush(user);
    this.logger.log(`User registered successfully: ${user.email}`);

    const tokens = await this.generateTokens(user);
    return tokens;
  }

  async refreshToken(refreshToken: string): Promise<TokenResponseDto> {
    this.logger.debug('Refreshing token');

    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      const user = await this.userRepository.findOne({ id: payload.sub });
      if (!user) {
        this.logger.warn(`User not found for refresh token: ${payload.sub}`);
        throw new UnauthorizedException('User not found');
      }

      const tokens = await this.generateTokens(user);
      this.logger.log(`Token refreshed for user: ${user.email}`);
      
      return tokens;
    } catch (error) {
      this.logger.error(`Token refresh failed: ${error.message}`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async generateTokens(user: User): Promise<TokenResponseDto> {
    const payload = {
      sub: user.id,
      email: user.email,
      first_name: user.first_name,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      }),
    ]);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 900, // 15 minutes in seconds
    };
  }
}
```

#### Auth Controller

**src/modules/auth/auth.controller.ts**
```typescript
import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto): Promise<TokenResponseDto> {
    return this.authService.register(registerDto);
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto): Promise<TokenResponseDto> {
    return this.authService.login(loginDto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body('refresh_token') refreshToken: string): Promise<TokenResponseDto> {
    return this.authService.refreshToken(refreshToken);
  }
}
```

#### JWT Strategy

**src/modules/auth/strategies/jwt.strategy.ts**
```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { User } from '../../../entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  async validate(payload: any): Promise<User> {
    const user = await this.userRepository.findOne({ id: payload.sub });
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
```

#### Auth Module

**src/modules/auth/auth.module.ts**
```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { User } from '../../entities/user.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([User]),
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

#### DTOs

**src/modules/auth/dto/login.dto.ts**
```typescript
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}
```

**src/modules/auth/dto/register.dto.ts**
```typescript
import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  first_name!: string;

  @IsString()
  @IsOptional()
  last_name?: string;

  @IsString()
  @IsOptional()
  username?: string;
}
```

**src/modules/auth/dto/token-response.dto.ts**
```typescript
export class TokenResponseDto {
  access_token!: string;
  refresh_token!: string;
  expires_in!: number;
}
```

#### Update App Module

**src/app.module.ts**
```typescript
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
// ... other imports
import { AuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    // ... existing imports
    AuthModule,
  ],
  // ...
})
export class AppModule {}
```

#### Update Main.ts for CORS

**src/main.ts**
```typescript
import { config } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';

config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // Enable CORS
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

#### Environment Variables (Backend)

**.env**
```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=accounting

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=your-super-secret-refresh-key-change-in-production
JWT_REFRESH_EXPIRES_IN=7d

# CORS
FRONTEND_URL=http://localhost:5173

# Server
PORT=3000
```

---

### 2.2 Frontend: React OAuth2 Implementation

#### Token Manager

**src/auth/tokenManager.ts**
```typescript
const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const TOKEN_EXPIRY_KEY = 'token_expiry';

export class TokenManager {
  static setTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
    const expiryTime = Date.now() + expiresIn * 1000;
    
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    localStorage.setItem(TOKEN_EXPIRY_KEY, expiryTime.toString());
  }

  static getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  static getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  }

  static isTokenExpired(): boolean {
    const expiryTime = localStorage.getItem(TOKEN_EXPIRY_KEY);
    if (!expiryTime) return true;
    
    return Date.now() >= parseInt(expiryTime, 10);
  }

  static clearTokens(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  }
}
```

#### API Client with Token Refresh

**src/api/client.ts**
```typescript
import axios, { AxiosInstance, InternalAxiosRequestConfig, AxiosError } from 'axios';
import { config } from '../config/env';
import { TokenManager } from '../auth/tokenManager';
import { logger } from '../utils/logger';

class ApiClient {
  private client: AxiosInstance;
  private isRefreshing = false;
  private failedQueue: Array<{
    resolve: (value?: any) => void;
    reject: (error?: any) => void;
  }> = [];

  constructor() {
    this.client = axios.create({
      baseURL: config.apiUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - Add token
    this.client.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        const token = TokenManager.getAccessToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor - Handle token refresh
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

        // If 401 and not already retrying
        if (error.response?.status === 401 && !originalRequest._retry) {
          if (this.isRefreshing) {
            // Queue the request
            return new Promise((resolve, reject) => {
              this.failedQueue.push({ resolve, reject });
            })
              .then((token) => {
                if (originalRequest.headers) {
                  originalRequest.headers.Authorization = `Bearer ${token}`;
                }
                return this.client(originalRequest);
              })
              .catch((err) => {
                return Promise.reject(err);
              });
          }

          originalRequest._retry = true;
          this.isRefreshing = true;

          const refreshToken = TokenManager.getRefreshToken();
          if (!refreshToken) {
            TokenManager.clearTokens();
            window.location.href = '/login';
            return Promise.reject(error);
          }

          try {
            const response = await axios.post(`${config.apiUrl}/auth/refresh`, {
              refresh_token: refreshToken,
            });

            const { access_token, refresh_token, expires_in } = response.data;
            TokenManager.setTokens(access_token, refresh_token, expires_in);

            // Process queued requests
            this.processQueue(null, access_token);

            // Retry original request
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${access_token}`;
            }
            return this.client(originalRequest);
          } catch (refreshError) {
            this.processQueue(refreshError, null);
            TokenManager.clearTokens();
            window.location.href = '/login';
            return Promise.reject(refreshError);
          } finally {
            this.isRefreshing = false;
          }
        }

        return Promise.reject(error);
      }
    );
  }

  private processQueue(error: any, token: string | null): void {
    this.failedQueue.forEach((promise) => {
      if (error) {
        promise.reject(error);
      } else {
        promise.resolve(token);
      }
    });
    this.failedQueue = [];
  }

  getClient(): AxiosInstance {
    return this.client;
  }
}

export const apiClient = new ApiClient().getClient();
```

#### Auth API

**src/api/auth.api.ts**
```typescript
import { apiClient } from './client';
import { TokenManager } from '../auth/tokenManager';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export const authApi = {
  login: async (credentials: LoginCredentials): Promise<TokenResponse> => {
    const response = await apiClient.post<TokenResponse>('/auth/login', credentials);
    TokenManager.setTokens(
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in
    );
    return response.data;
  },

  register: async (data: RegisterData): Promise<TokenResponse> => {
    const response = await apiClient.post<TokenResponse>('/auth/register', data);
    TokenManager.setTokens(
      response.data.access_token,
      response.data.refresh_token,
      response.data.expires_in
    );
    return response.data;
  },

  logout: (): void => {
    TokenManager.clearTokens();
  },

  isAuthenticated: (): boolean => {
    return !!TokenManager.getAccessToken() && !TokenManager.isTokenExpired();
  },
};
```

#### Auth Context

**src/auth/AuthContext.tsx**
```typescript
import { createContext, useContext } from 'react';
import { User } from '../api/types';

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
```

#### Auth Provider

**src/auth/AuthProvider.tsx**
```typescript
import React, { useState, useEffect, useCallback } from 'react';
import { AuthContext, AuthContextType } from './AuthContext';
import { authApi, RegisterData } from '../api/auth.api';
import { apiClient } from '../api/client';
import { User } from '../api/types';
import { logger } from '../utils/logger';

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      if (!authApi.isAuthenticated()) {
        setIsLoading(false);
        return;
      }

      const response = await apiClient.get<User>('/auth/me');
      setUser(response.data);
    } catch (error) {
      logger.error('Failed to load user', error);
      authApi.logout();
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  const login = async (email: string, password: string): Promise<void> => {
    try {
      await authApi.login({ email, password });
      await loadUser();
    } catch (error) {
      logger.error('Login failed', error);
      throw error;
    }
  };

  const register = async (data: RegisterData): Promise<void> => {
    try {
      await authApi.register(data);
      await loadUser();
    } catch (error) {
      logger.error('Registration failed', error);
      throw error;
    }
  };

  const logout = (): void => {
    authApi.logout();
    setUser(null);
  };

  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    register,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
```

---

## Part 3: Logging Implementation

### 3.1 Backend Logging

#### Install Winston

```bash
npm install nest-winston winston
```

#### Logger Module

**src/common/logger/logger.module.ts**
```typescript
import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import * as path from 'path';

@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        // Console transport
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
              return `${timestamp} [${context || 'Application'}] ${level}: ${message} ${
                Object.keys(meta).length ? JSON.stringify(meta) : ''
              }`;
            })
          ),
        }),
        // File transport for errors
        new winston.transports.File({
          filename: path.join('logs', 'error.log'),
          level: 'error',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        }),
        // File transport for all logs
        new winston.transports.File({
          filename: path.join('logs', 'combined.log'),
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          ),
        }),
      ],
    }),
  ],
})
export class LoggerModule {}
```

#### Update Main.ts

**src/main.ts**
```typescript
import { config } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Use Winston logger
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    })
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  
  app.get(WINSTON_MODULE_NEST_PROVIDER).log(`Application is running on: http://localhost:${port}`);
}
bootstrap();
```

### 3.2 Frontend Logging

**src/utils/logger.ts**
```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: string;
  data?: any;
}

class Logger {
  private logLevel: LogLevel;

  constructor() {
    this.logLevel = (import.meta.env.VITE_LOG_LEVEL as LogLevel) || 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private log(level: LogLevel, message: string, context?: string, data?: any): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
      data,
    };

    // Console logging
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[consoleMethod](`[${entry.timestamp}] [${context || 'App'}] ${message}`, data || '');

    // Send to backend in production
    if (import.meta.env.PROD && (level === 'error' || level === 'warn')) {
      this.sendToBackend(entry);
    }
  }

  private async sendToBackend(entry: LogEntry): Promise<void> {
    try {
      // Only send critical logs to reduce noise
      await fetch(`${import.meta.env.VITE_API_URL}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch (error) {
      // Silently fail - don't log logging errors
    }
  }

  debug(message: string, context?: string, data?: any): void {
    this.log('debug', message, context, data);
  }

  info(message: string, context?: string, data?: any): void {
    this.log('info', message, context, data);
  }

  warn(message: string, context?: string, data?: any): void {
    this.log('warn', message, context, data);
  }

  error(message: string, context?: string, error?: any): void {
    this.log('error', message, context, {
      message: error?.message,
      stack: error?.stack,
      ...error,
    });
  }
}

export const logger = new Logger();
```

---

## Part 4: Integration Steps

### 4.1 Backend Setup Checklist

- [ ] Install OAuth2 dependencies
- [ ] Create auth module structure
- [ ] Update User entity with password field
- [ ] Create migration for password field
- [ ] Implement auth service with token refresh
- [ ] Set up JWT strategy
- [ ] Configure CORS
- [ ] Set up Winston logging
- [ ] Create logs directory
- [ ] Add environment variables
- [ ] Test endpoints with Postman/curl

### 4.2 Frontend Setup Checklist

- [ ] Create React app
- [ ] Install dependencies
- [ ] Set up project structure
- [ ] Create API client with interceptors
- [ ] Implement token manager
- [ ] Create auth context and provider
- [ ] Set up routing with protected routes
- [ ] Create login/register pages
- [ ] Implement frontend logging
- [ ] Test authentication flow

### 4.3 Testing Authentication Flow

1. **Register new user**
2. **Login with credentials**
3. **Access protected route**
4. **Wait for token expiry (or manually expire)**
5. **Make API request - should auto-refresh**
6. **Logout**
7. **Try accessing protected route - should redirect**

---

## Part 5: Security Best Practices

1. **HTTPS in Production** - Always use HTTPS
2. **Secure Token Storage** - Consider httpOnly cookies for refresh tokens
3. **Token Rotation** - Implement refresh token rotation
4. **Rate Limiting** - Add rate limiting to auth endpoints
5. **Password Requirements** - Enforce strong passwords
6. **CSRF Protection** - Add CSRF tokens if using cookies
7. **Logging** - Don't log sensitive data (passwords, tokens)
8. **Environment Variables** - Never commit secrets

---

## Additional Resources

- [NestJS Authentication](https://docs.nestjs.com/security/authentication)
- [Passport.js Documentation](http://www.passportjs.org/)
- [JWT Best Practices](https://datatracker.ietf.org/doc/html/rfc8725)
- [React Router](https://reactrouter.com/)
- [Axios Interceptors](https://axios-http.com/docs/interceptors)

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-XX






