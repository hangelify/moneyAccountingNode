# OAuth2 Setup Instructions

## Overview

This document provides setup instructions for the OAuth2 authentication system that has been implemented in the NestJS backend.

## Prerequisites

Before running the application, you need to install the required dependencies.

## Step 1: Install Required Packages

Run the following command to install all required OAuth2 and authentication packages:

```bash
npm install @nestjs/jwt @nestjs/passport passport passport-jwt passport-local bcrypt class-validator class-transformer
npm install -D @types/passport-jwt @types/passport-local @types/bcrypt
```

## Step 2: Environment Variables

Add the following environment variables to your `.env` file:

```env
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-minimum-32-characters-long
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=your-super-secret-refresh-key-minimum-32-characters-long
JWT_REFRESH_EXPIRES_IN=7d

# CORS Configuration
FRONTEND_URL=http://localhost:5173

# Server Configuration
PORT=3000
```

**Important**: 
- Generate strong, random secrets for `JWT_SECRET` and `JWT_REFRESH_SECRET`
- Use at least 32 characters for security
- Never commit these secrets to version control

## Step 3: Run Migrations

Execute the migrations to create the necessary database tables:

```bash
# Check pending migrations
npm run migration:pending

# Run migrations
npm run migration:up
```

The following migrations will be executed:
1. `Migration20251225120000_AddEmailAndPasswordToUsers` - Adds email and password to users table
2. `Migration20251225120001_CreateLogsTable` - Creates logs table for application logging
3. `Migration20251225120002_CreateSessionsTable` - Creates sessions table for OAuth2 sessions
4. `Migration20251225120003_CreateRefreshTokensTable` - Creates refresh_tokens table for token management

## Step 4: Verify Installation

Start the application:

```bash
npm run start:dev
```

The application should start without errors. You can test the authentication endpoints:

### Test Registration
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123",
    "first_name": "Test",
    "last_name": "User"
  }'
```

### Test Login
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

### Test Token Refresh
```bash
curl -X POST http://localhost:3000/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refresh_token": "your-refresh-token-here"
  }'
```

### Test Protected Route
```bash
curl -X GET http://localhost:3000/auth/me \
  -H "Authorization: Bearer your-access-token-here"
```

## API Endpoints

### Authentication Endpoints

- `POST /auth/register` - Register a new user
  - Body: `{ email, password, first_name, last_name?, username? }`
  - Returns: `{ access_token, refresh_token, expires_in, token_type }`

- `POST /auth/login` - Login with email and password
  - Body: `{ email, password }`
  - Returns: `{ access_token, refresh_token, expires_in, token_type }`

- `POST /auth/refresh` - Refresh access token
  - Body: `{ refresh_token }`
  - Returns: `{ access_token, refresh_token, expires_in, token_type }`

- `POST /auth/logout` - Logout (requires authentication)
  - Headers: `Authorization: Bearer <access_token>`
  - Body (optional): `{ refresh_token }`
  - Returns: `{ message: "Logged out successfully" }`

- `GET /auth/me` - Get current user profile (requires authentication)
  - Headers: `Authorization: Bearer <access_token>`
  - Returns: User profile without password

## Database Tables

### Users Table
- Added `email` field (unique, required)
- Added `password` field (hidden by default, required)
- Password is automatically hashed using bcrypt before saving

### Sessions Table
- Tracks active user sessions
- Stores session tokens, IP addresses, and user agents
- Automatically expires based on JWT expiration

### Refresh Tokens Table
- Stores refresh tokens for OAuth2 flow
- Implements token rotation (old tokens are revoked when new ones are issued)
- Tracks token families for security

### Logs Table
- Stores application logs with different levels (DEBUG, INFO, WARN, ERROR)
- Tracks log sources (BACKEND, FRONTEND, API, AUTH, DATABASE)
- Stores metadata, IP addresses, and user agents
- Can be linked to specific users

## Security Features

1. **Password Hashing**: Passwords are hashed using bcrypt with salt rounds of 10
2. **Token Rotation**: Refresh tokens are rotated on each use for enhanced security
3. **Token Families**: Related tokens are grouped by family_id for tracking
4. **Session Management**: Active sessions are tracked and can be revoked
5. **Logging**: All authentication attempts are logged with IP addresses and user agents
6. **Hidden Password Field**: Password field is hidden by default in User entity - must explicitly select it

## Usage in Code

### Protecting Routes

Use the `JwtAuthGuard` to protect routes:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../entities/user.entity';

@Controller('protected')
@UseGuards(JwtAuthGuard)
export class ProtectedController {
  @Get()
  getProtectedData(@CurrentUser() user: User) {
    return { message: `Hello ${user.first_name}`, user };
  }
}
```

### Accessing Current User

Use the `@CurrentUser()` decorator to get the authenticated user:

```typescript
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Get('profile')
getProfile(@CurrentUser() user: User) {
  return user;
}
```

### Logging

The auth service automatically logs authentication attempts. You can also manually log events:

```typescript
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { Log, LogLevel, LogSource } from '../entities/log.entity';

// In your service
constructor(
  @InjectRepository(Log)
  private readonly logRepository: EntityRepository<Log>,
) {}

async logEvent(message: string, level: LogLevel = LogLevel.INFO) {
  const log = this.logRepository.create({
    level,
    source: LogSource.BACKEND,
    context: 'YourContext',
    message,
  });
  await this.logRepository.persistAndFlush(log);
}
```

## Troubleshooting

### Migration Errors

If you encounter migration errors:
1. Check that all previous migrations have been run
2. Verify database connection settings
3. Check for existing data conflicts

### Authentication Errors

- **401 Unauthorized**: Check that JWT_SECRET matches between token generation and validation
- **Token Expired**: Access tokens expire after 15 minutes (configurable). Use refresh token to get new access token
- **Invalid Credentials**: Verify email and password are correct

### Password Field Not Accessible

The password field is hidden by default. To access it, explicitly select it in your query:

```typescript
const user = await this.userRepository.findOne(
  { email },
  { fields: ['id', 'email', 'password'] } // Explicitly include password
);
```

## Next Steps

1. Implement password reset functionality
2. Add email verification
3. Implement rate limiting for auth endpoints
4. Add two-factor authentication (2FA)
5. Set up log rotation and cleanup jobs
6. Implement session cleanup for expired sessions

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-XX






