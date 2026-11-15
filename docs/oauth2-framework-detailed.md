# OAuth 2.0 Framework with Database Session Validation

## Overview

This document provides a comprehensive guide to the OAuth 2.0 authentication framework implemented in the Accounting application, following Auth0 best practices. The framework includes robust database session checks, token validation, and security measures to ensure secure authentication flows.

**Reference**: Based on [Auth0 Documentation](https://auth0.com/docs) and OAuth 2.0 best practices.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [Registration Flow](#registration-flow)
4. [Login Flow](#login-flow)
5. [Refresh Token Flow](#refresh-token-flow)
6. [Logout Flow](#logout-flow)
7. [Session Validation Framework](#session-validation-framework)
8. [Security Best Practices](#security-best-practices)
9. [Error Handling](#error-handling)
10. [API Reference](#api-reference)

---

## Architecture Overview

### Core Components

- **AuthService**: Implements all authentication business logic
- **AuthController**: REST API endpoints for authentication
- **JwtStrategy**: Validates JWT tokens and performs database session checks
- **LocalStrategy**: Validates email/password credentials
- **JwtAuthGuard**: Protects routes requiring authentication
- **Session Entity**: Tracks active user sessions in database
- **RefreshToken Entity**: Manages refresh tokens with rotation support
- **Log Entity**: Comprehensive audit logging

### Token Types

1. **Access Token (JWT)**
   - Short-lived (default: 15 minutes / 900,000ms)
   - Used for API authentication
   - Stored in `sessions` table
   - **Validated against database on every request**
   - Contains: `sub` (user ID), `email`, `first_name`

2. **Refresh Token (JWT)**
   - Long-lived (default: 7 days / 6,048,000ms)
   - Used to obtain new access tokens
   - Stored in `refresh_tokens` table
   - **Rotated on each use** (old token revoked)
   - Contains: `sub` (user ID), `email`, `first_name`

### Key Security Features

- ✅ **Database Session Validation**: Every access token is validated against the database
- ✅ **Token Rotation**: Refresh tokens are rotated on each use
- ✅ **Immediate Logout**: Database check prevents token reuse after logout
- ✅ **Session Expiration**: Automatic expiration and cleanup
- ✅ **Password Hashing**: bcrypt with 10 rounds
- ✅ **Comprehensive Logging**: All authentication events logged
- ✅ **IP Address & User Agent Tracking**: Security monitoring

---

## Database Schema

### Users Table

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL, -- Hidden field, hashed with bcrypt
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255),
  username VARCHAR(255),
  currency VARCHAR(50) NOT NULL DEFAULT 'EUR',
  language_code VARCHAR(10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
```

### Sessions Table

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(500) UNIQUE NOT NULL, -- Stores access token
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  INDEX idx_session_token (session_token),
  INDEX idx_user_id (user_id)
);
```

**Purpose**: Tracks active user sessions. The `session_token` field stores the JWT access token, allowing database validation on every request.

### Refresh Tokens Table

```sql
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) UNIQUE NOT NULL, -- Stores refresh token
  family_id VARCHAR(255), -- For token rotation tracking
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX idx_token (token),
  INDEX idx_family_id (family_id),
  INDEX idx_user_id (user_id)
);
```

**Purpose**: Manages refresh tokens with rotation support. The `family_id` groups related tokens for rotation tracking.

### Logs Table

```sql
CREATE TABLE logs (
  id UUID PRIMARY KEY,
  level VARCHAR(20) NOT NULL, -- INFO, WARN, ERROR
  source VARCHAR(50) NOT NULL, -- AUTH, API, SYSTEM
  context VARCHAR(255),
  message TEXT NOT NULL,
  metadata JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Purpose**: Comprehensive audit logging for all authentication events.

---

## Registration Flow

### Endpoint
```
POST /auth/register
```

### Request Body
```json
{
  "email": "user@example.com",
  "password": "password123",
  "first_name": "John",
  "last_name": "Doe",
  "username": "johndoe" // optional
}
```

### Step-by-Step Process

#### Step 1: Request Validation
- **Validation**: Email format, password minimum length (6 characters), required fields
- **Framework**: NestJS `ValidationPipe` with `class-validator`
- **Error**: Returns `400 Bad Request` if validation fails

#### Step 2: Database Check - User Existence
```typescript
const existingUser = await this.userRepository.findOne({
  email: registerDto.email,
});
```
- **Check**: Verify user doesn't already exist
- **Error**: Returns `400 Bad Request` with message "User already exists" if found
- **Logging**: WARN level log entry created

#### Step 3: User Creation
```typescript
const user = new User();
user.email = registerDto.email;
user.password = registerDto.password; // Automatically hashed in @BeforeCreate hook
user.first_name = registerDto.first_name;
user.last_name = registerDto.last_name;
user.username = registerDto.username;
user.currency = Currency.EUR; // Default currency
```
- **Password Hashing**: Automatically hashed with bcrypt (10 rounds) in `@BeforeCreate` hook
- **Database Transaction**: User persisted to database
- **Logging**: INFO level log entry created

#### Step 4: Token Generation
```typescript
const payload: JwtPayload = {
  sub: user.id,
  email: user.email,
  first_name: user.first_name,
};

const accessToken = await jwtService.signAsync(payload, {
  secret: process.env.JWT_SECRET,
  expiresIn: Math.floor(parseInt(process.env.JWT_EXPIRES_IN_MS) / 1000), // Convert ms to seconds
});

const refreshToken = await jwtService.signAsync(payload, {
  secret: process.env.JWT_REFRESH_SECRET,
  expiresIn: Math.floor(parseInt(process.env.JWT_REFRESH_EXPIRES_IN_MS) / 1000),
});
```
- **Access Token**: Short-lived JWT (default: 15 minutes)
- **Refresh Token**: Long-lived JWT (default: 7 days)
- **Secrets**: Different secrets for access and refresh tokens

#### Step 5: Database Session Creation
```typescript
const session = await this.createSession(user, accessToken, ipAddress, userAgent);
```
- **Session Record Created**:
  - `session_token` = access token
  - `user_id` = user ID
  - `expires_at` = current time + access token expiration
  - `is_active` = true
  - `ip_address` = client IP (if available)
  - `user_agent` = client user agent (if available)
- **Purpose**: Enables database validation on subsequent requests

#### Step 6: Database Refresh Token Creation
```typescript
const refreshTokenEntity = await this.createRefreshToken(
  user,
  refreshToken,
  ipAddress,
  userAgent,
);
```
- **Refresh Token Record Created**:
  - `token` = refresh token
  - `user_id` = user ID
  - `family_id` = unique identifier (for token rotation)
  - `expires_at` = current time + refresh token expiration
  - `is_active` = true
  - `is_revoked` = false
- **Purpose**: Enables refresh token validation and rotation

#### Step 7: Audit Logging
```typescript
await this.logAuthAttempt(registerDto.email, true, 'Registration successful');
```
- **Log Entry Created**:
  - `level` = INFO
  - `source` = AUTH
  - `message` = "Auth attempt: Registration successful - {email}"
  - `metadata` = { email, success: true }
  - `ip_address` = client IP
  - `user_agent` = client user agent

#### Step 8: Response
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```
- **Status Code**: `201 Created`
- **Response Type**: `TokenResponseDto`

### Database State After Registration

| Table | Records Created | Status |
|-------|----------------|--------|
| `users` | 1 | Active user with hashed password |
| `sessions` | 1 | Active session with access token |
| `refresh_tokens` | 1 | Active, not revoked refresh token |
| `logs` | 1 | INFO level log entry |

### Security Validations

1. ✅ **Email Uniqueness**: Enforced at database level and application level
2. ✅ **Password Strength**: Minimum 6 characters (can be enhanced)
3. ✅ **Password Hashing**: bcrypt with 10 rounds
4. ✅ **Token Storage**: Tokens stored in database for validation
5. ✅ **IP Tracking**: Client IP address logged for security monitoring

---

## Login Flow

### Endpoint
```
POST /auth/login
```

### Request Body
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

### Step-by-Step Process

#### Step 1: Request Validation
- **Validation**: Email format, password required
- **Framework**: NestJS `ValidationPipe` with `class-validator`
- **Error**: Returns `400 Bad Request` if validation fails

#### Step 2: Local Strategy Validation
- **Guard**: `LocalAuthGuard` extracts email and password from request body
- **Strategy**: `LocalStrategy` calls `AuthService.validateUser()`

#### Step 3: Database Check - User Lookup
```typescript
const user = await this.userRepository.findOne(
  { email },
  {
    fields: ['id', 'email', 'first_name', 'last_name', 'username', 'password', ...],
  },
);
```
- **Check**: Find user by email (including password field)
- **Error**: If user not found:
  - Returns `null` from `validateUser()`
  - Logs WARN level entry: "User not found: {email}"
  - Throws `401 Unauthorized` with message "Invalid credentials"

#### Step 4: Password Validation
```typescript
const isPasswordValid = await user.validatePassword(password);
```
- **Validation**: Uses bcrypt.compare() to verify password against stored hash
- **Error**: If password invalid:
  - Returns `null` from `validateUser()`
  - Logs WARN level entry: "Invalid password for user: {email}"
  - Throws `401 Unauthorized` with message "Invalid credentials"

#### Step 5: Token Generation
- **Same as Registration Flow Step 4**
- Generates new access token and refresh token

#### Step 6: Database Session Creation
- **Same as Registration Flow Step 5**
- Creates new session record (allows multiple active sessions per user)

#### Step 7: Database Refresh Token Creation
- **Same as Registration Flow Step 6**
- Creates new refresh token with new `family_id`

#### Step 8: Audit Logging
```typescript
await this.logAuthAttempt(loginDto.email, true, 'Login successful');
```
- **Log Entry Created**:
  - `level` = INFO (success) or WARN (failure)
  - `source` = AUTH
  - `message` = "Auth attempt: Login successful - {email}" or "Auth attempt: Invalid password - {email}"
  - `metadata` = { email, success: true/false, reason: "..." }

#### Step 9: Response
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```
- **Status Code**: `200 OK`
- **Response Type**: `TokenResponseDto`

### Database State After Login

| Table | Records Created | Status |
|-------|----------------|--------|
| `users` | 0 (unchanged) | Existing user |
| `sessions` | 1 (new) | Active session with new access token |
| `refresh_tokens` | 1 (new) | Active, not revoked refresh token |
| `logs` | 1 (new) | INFO (success) or WARN (failure) log entry |

### Security Validations

1. ✅ **User Existence**: Verified in database
2. ✅ **Password Verification**: bcrypt.compare() against stored hash
3. ✅ **Failed Attempt Logging**: All failed login attempts logged
4. ✅ **Rate Limiting**: Can be added (not currently implemented)
5. ✅ **Account Lockout**: Can be added (not currently implemented)

---

## Refresh Token Flow

### Endpoint
```
POST /auth/refresh
```

### Request Body
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Step-by-Step Process

#### Step 1: Request Validation
- **Validation**: Refresh token required
- **Framework**: NestJS `ValidationPipe` with `class-validator`
- **Error**: Returns `400 Bad Request` if validation fails

#### Step 2: JWT Signature Verification
```typescript
this.jwtService.verify<JwtPayload>(refreshToken, {
  secret: process.env.JWT_REFRESH_SECRET!,
});
```
- **Verification**: Validates JWT signature using `JWT_REFRESH_SECRET`
- **Validation**: Checks token expiration (JWT-level)
- **Error**: If invalid or expired:
  - Throws `401 Unauthorized` with message "Invalid refresh token"
  - Logs ERROR level entry

#### Step 3: Database Check - Refresh Token Existence
```typescript
const tokenEntity = await this.refreshTokenRepository.findOne(
  {
    token: refreshToken,
    is_active: true,
    is_revoked: false,
  },
  { populate: ['user'] },
);
```
- **Check**: Find refresh token in database
- **Validations**:
  - Token must exist
  - `is_active` must be `true`
  - `is_revoked` must be `false`
- **Error**: If not found or revoked:
  - Throws `401 Unauthorized` with message "Invalid refresh token"
  - Logs WARN level entry: "Refresh token not found or revoked"

#### Step 4: Database Check - Token Expiration
```typescript
if (new Date() > tokenEntity.expires_at) {
  tokenEntity.is_active = false;
  await this.em.persistAndFlush(tokenEntity);
  throw new UnauthorizedException('Refresh token expired');
}
```
- **Check**: Compare current time with `expires_at` in database
- **Action**: If expired, mark token as inactive
- **Error**: Throws `401 Unauthorized` with message "Refresh token expired"

#### Step 5: Token Rotation - Revoke Old Token
```typescript
tokenEntity.is_revoked = true;
tokenEntity.is_active = false;
await this.em.persistAndFlush(tokenEntity);
```
- **Security**: Prevents token reuse
- **Action**: Marks old refresh token as revoked and inactive
- **Purpose**: If token is stolen, it can only be used once

#### Step 6: Generate New Tokens
```typescript
const newTokens = await this.generateTokens(user);
```
- **Same as Registration Flow Step 4**
- Generates new access token and new refresh token

#### Step 7: Database Session Update/Creation
```typescript
await this.updateOrCreateSession(
  user,
  newTokens.access_token,
  ipAddress,
  userAgent,
);
```
- **Logic**:
  - Finds existing active session for user
  - If found: Updates `session_token` with new access token, updates `expires_at`, updates `last_activity_at`
  - If not found: Creates new session
- **Purpose**: Ensures session is renewed with new access token

#### Step 8: Database Refresh Token Creation
```typescript
await this.createRefreshToken(
  user,
  newTokens.refresh_token,
  ipAddress,
  userAgent,
  tokenEntity.family_id, // Reuse family_id for rotation tracking
);
```
- **Family ID**: Reuses `family_id` from old token (for rotation tracking)
- **New Record Created**: New refresh token with same `family_id`

#### Step 9: Response
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```
- **Status Code**: `200 OK`
- **Response Type**: `TokenResponseDto`

### Database State After Refresh

| Table | Records Updated | Records Created | Status |
|-------|----------------|-----------------|--------|
| `sessions` | 1 (updated) | 0 | Session updated with new access token |
| `refresh_tokens` | 1 (revoked) | 1 (new) | Old token revoked, new token active |
| `logs` | 0 | 0 | No log entry (can be added) |

### Security Validations

1. ✅ **JWT Signature Verification**: Validates token signature
2. ✅ **Database Token Validation**: Verifies token exists and is active
3. ✅ **Token Expiration Check**: Validates expiration in database
4. ✅ **Token Rotation**: Old token revoked immediately
5. ✅ **Session Renewal**: Session updated with new access token
6. ✅ **Family ID Tracking**: Groups related tokens for security monitoring

### Token Rotation Benefits

- **Prevents Token Reuse**: If a refresh token is stolen, it can only be used once
- **Immediate Revocation**: Old token is revoked as soon as new one is issued
- **Security Monitoring**: `family_id` allows tracking of token families
- **Compromise Detection**: If old token is used after rotation, it indicates compromise

---

## Logout Flow

### Endpoint
```
POST /auth/logout
```

### Headers
```
Authorization: Bearer {access_token}
```

### Request Body (Optional)
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### Step-by-Step Process

#### Step 1: Authentication Check
- **Guard**: `JwtAuthGuard` validates access token
- **Strategy**: `JwtStrategy` performs database session check
- **Error**: If invalid:
  - Throws `401 Unauthorized`
  - Returns before logout logic executes

#### Step 2: Database Check - Session Validation
- **Performed by JwtStrategy** (see [Session Validation Framework](#session-validation-framework))
- **Validations**:
  - Token exists in `sessions` table
  - Session `is_active` = true
  - Session not expired
- **Error**: If session invalid:
  - Throws `401 Unauthorized` with message "Session not found or user has logged out"

#### Step 3: Optional Refresh Token Revocation
```typescript
if (refreshToken) {
  const tokenEntity = await this.refreshTokenRepository.findOne({
    token: refreshToken,
    user: { id: userId },
  });

  if (tokenEntity) {
    tokenEntity.is_revoked = true;
    tokenEntity.is_active = false;
    await this.em.persistAndFlush(tokenEntity);
  }
}
```
- **Check**: If refresh token provided, find it in database
- **Action**: If found, mark as revoked and inactive
- **Purpose**: Prevents refresh token from being used after logout

#### Step 4: Database Session Deactivation
```typescript
await this.sessionRepository.nativeUpdate(
  { user: { id: userId }, is_active: true },
  { is_active: false },
);
```
- **Action**: Deactivates **all active sessions** for the user
- **Scope**: All devices/browsers logged out simultaneously
- **Purpose**: Immediate logout enforcement

#### Step 5: Response
```json
{
  "message": "Logged out successfully"
}
```
- **Status Code**: `200 OK`

### Database State After Logout

| Table | Records Updated | Status |
|-------|----------------|--------|
| `sessions` | All active sessions | `is_active` = false |
| `refresh_tokens` | 1 (if provided) | `is_revoked` = true, `is_active` = false |

### Security Validations

1. ✅ **Access Token Validation**: Required for logout endpoint
2. ✅ **Database Session Check**: Verifies session is active before logout
3. ✅ **Immediate Deactivation**: All sessions deactivated immediately
4. ✅ **Refresh Token Revocation**: Optional refresh token revocation
5. ✅ **Multi-Device Logout**: All devices logged out simultaneously

### Logout Enforcement

After logout, any subsequent request with the same access token will fail:

1. **Request with Old Token**:
   ```
   GET /auth/me
   Authorization: Bearer {old_access_token}
   ```

2. **JwtStrategy Validation**:
   ```typescript
   const session = await this.sessionRepository.findOne({
     session_token: token,
     user: { id: payload.sub },
     is_active: true, // This will be false after logout
   });
   ```

3. **Result**: `401 Unauthorized` with message "Session not found or user has logged out"

---

## Session Validation Framework

### Overview

Every request to a protected endpoint undergoes database session validation through the `JwtStrategy.validate()` method.

### Validation Process

#### Step 1: JWT Token Extraction
```typescript
const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request);
```
- **Source**: Extracted from `Authorization: Bearer {token}` header
- **Error**: If missing, validation fails

#### Step 2: JWT Payload Validation
```typescript
const payload = jwtService.verify(token, { secret: process.env.JWT_SECRET });
```
- **Validation**: JWT signature and expiration
- **Error**: If invalid, throws `UnauthorizedException`

#### Step 3: Database User Check
```typescript
const user = await this.userRepository.findOne({ id: payload.sub });
```
- **Check**: User exists in database
- **Error**: If not found, throws `401 Unauthorized` with message "User not found"

#### Step 4: Database Session Check
```typescript
const session = await this.sessionRepository.findOne({
  session_token: token,
  user: { id: payload.sub },
  is_active: true,
});
```
- **Check**: Session exists with matching token
- **Validations**:
  - `session_token` matches provided token
  - `user_id` matches token payload
  - `is_active` = true
- **Error**: If not found, throws `401 Unauthorized` with message "Session not found or user has logged out"

#### Step 5: Session Expiration Check
```typescript
if (new Date() > session.expires_at) {
  session.is_active = false;
  await this.em.persistAndFlush(session);
  throw new UnauthorizedException('Session has expired');
}
```
- **Check**: Session not expired
- **Action**: If expired, mark as inactive
- **Error**: Throws `401 Unauthorized` with message "Session has expired"

#### Step 6: Activity Update
```typescript
session.last_activity_at = new Date();
await this.em.persistAndFlush(session);
```
- **Action**: Update `last_activity_at` timestamp
- **Purpose**: Track user activity for security monitoring

#### Step 7: Return Authenticated User
```typescript
return user as AuthenticatedUser;
```
- **Result**: User object attached to `request.user`
- **Available**: In controller via `@CurrentUser()` decorator

### Validation Flow Diagram

```
┌─────────────────┐
│  Client Request │
│  Authorization: │
│  Bearer {token} │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  JwtAuthGuard   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  JwtStrategy    │
│  validate()     │
└────────┬────────┘
         │
         ├─► 1. Extract Token
         │
         ├─► 2. Verify JWT Signature
         │
         ├─► 3. Check User Exists
         │
         ├─► 4. Check Session Exists
         │      & is_active = true
         │
         ├─► 5. Check Session Not Expired
         │
         ├─► 6. Update last_activity_at
         │
         └─► 7. Return AuthenticatedUser
         │
         ▼
┌─────────────────┐
│   Controller    │
│   @CurrentUser()│
└─────────────────┘
```

### Security Benefits

1. ✅ **Immediate Logout Enforcement**: Database check prevents token reuse after logout
2. ✅ **Session Expiration**: Automatic expiration and cleanup
3. ✅ **Activity Tracking**: `last_activity_at` updated on every request
4. ✅ **Multi-Device Support**: Each device has separate session
5. ✅ **Compromise Detection**: Inactive sessions indicate potential compromise

---

## Security Best Practices

### Based on Auth0 Recommendations

#### 1. Token Storage
- ✅ **Access Tokens**: Stored in memory (JavaScript variable), never in localStorage
- ✅ **Refresh Tokens**: Stored in httpOnly cookies (recommended) or secure storage
- ✅ **Database Validation**: All tokens validated against database

#### 2. Token Expiration
- ✅ **Short-Lived Access Tokens**: Default 15 minutes
- ✅ **Long-Lived Refresh Tokens**: Default 7 days
- ✅ **Automatic Rotation**: Refresh tokens rotated on each use

#### 3. Password Security
- ✅ **Hashing**: bcrypt with 10 rounds
- ✅ **Never Exposed**: Password field hidden by default
- ✅ **Validation**: Minimum 6 characters (can be enhanced)

#### 4. Session Management
- ✅ **Database Tracking**: All sessions tracked in database
- ✅ **Immediate Revocation**: Sessions deactivated on logout
- ✅ **Expiration**: Automatic expiration and cleanup
- ✅ **Activity Tracking**: Last activity timestamp updated

#### 5. Audit Logging
- ✅ **Comprehensive Logging**: All authentication events logged
- ✅ **IP Tracking**: Client IP address logged
- ✅ **User Agent Tracking**: Client user agent logged
- ✅ **Metadata**: Additional context stored in JSONB field

#### 6. Error Handling
- ✅ **Generic Error Messages**: Don't reveal if user exists
- ✅ **Rate Limiting**: Can be added (not currently implemented)
- ✅ **Account Lockout**: Can be added (not currently implemented)

### Recommendations for Enhancement

1. **Rate Limiting**: Implement rate limiting on login/register endpoints
2. **Account Lockout**: Lock account after N failed login attempts
3. **Password Strength**: Enforce stronger password requirements
4. **2FA/MFA**: Add two-factor authentication
5. **Device Tracking**: Track and manage devices
6. **Session Cleanup**: Periodic cleanup of expired sessions
7. **Security Headers**: Add security headers (CORS, CSP, etc.)

---

## Error Handling

### Error Responses

#### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": ["email must be an email", "password must be longer than or equal to 6 characters"],
  "error": "Bad Request"
}
```
- **Causes**: Validation errors, user already exists

#### 401 Unauthorized
```json
{
  "statusCode": 401,
  "message": "Invalid credentials",
  "error": "Unauthorized"
}
```
- **Causes**: Invalid email/password, invalid/expired token, session not found

#### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "User not found",
  "error": "Not Found"
}
```
- **Causes**: User not found in database

### Error Logging

All errors are logged with appropriate levels:

- **INFO**: Successful operations
- **WARN**: Failed authentication attempts, invalid tokens
- **ERROR**: System errors, unexpected failures

---

## API Reference

### POST /auth/register

**Description**: Register a new user

**Authentication**: None required

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "first_name": "John",
  "last_name": "Doe",
  "username": "johndoe" // optional
}
```

**Response**: `201 Created`
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```

**Database Operations**:
- Creates User
- Creates Session
- Creates RefreshToken
- Creates Log (INFO)

---

### POST /auth/login

**Description**: Login with email and password

**Authentication**: None required (uses LocalAuthGuard)

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response**: `200 OK`
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```

**Database Operations**:
- Creates Session
- Creates RefreshToken
- Creates Log (INFO/WARN)

---

### POST /auth/refresh

**Description**: Refresh access token

**Authentication**: None required (validates refresh token)

**Request Body**:
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response**: `200 OK`
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 900,
  "token_type": "Bearer"
}
```

**Database Operations**:
- Updates Session (with new access token)
- Revokes old RefreshToken
- Creates new RefreshToken

---

### POST /auth/logout

**Description**: Logout user

**Authentication**: JWT required

**Headers**:
```
Authorization: Bearer {access_token}
```

**Request Body** (optional):
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response**: `200 OK`
```json
{
  "message": "Logged out successfully"
}
```

**Database Operations**:
- Updates all Sessions (is_active = false)
- Updates RefreshToken (if provided, is_revoked = true)

---

### GET /auth/me

**Description**: Get current user profile

**Authentication**: JWT required

**Headers**:
```
Authorization: Bearer {access_token}
```

**Response**: `200 OK`
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "email": "user@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "username": "johndoe",
  "currency": "EUR",
  "language_code": "en",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

**Database Operations**:
- Updates Session (last_activity_at)

---

## Conclusion

This OAuth 2.0 framework provides a robust, secure authentication system with comprehensive database session validation. Following Auth0 best practices, it ensures:

- ✅ Secure token management with rotation
- ✅ Database-backed session validation
- ✅ Immediate logout enforcement
- ✅ Comprehensive audit logging
- ✅ Multi-device support
- ✅ Security monitoring capabilities

For additional security enhancements, consider implementing rate limiting, account lockout, and two-factor authentication as recommended in the [Auth0 Documentation](https://auth0.com/docs).



