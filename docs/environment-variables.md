# Environment Variables

This document describes all environment variables used in the Accounting application.

## Database Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DB_HOST` | PostgreSQL database host | `localhost` | No |
| `DB_PORT` | PostgreSQL database port | `5432` | No |
| `DB_USER` | PostgreSQL database user | `postgres` | No |
| `DB_PASSWORD` | PostgreSQL database password | `postgres` | No |
| `DB_NAME` | PostgreSQL database name | `accounting` | No |

## JWT Authentication

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `JWT_SECRET` | Secret key for JWT access tokens | `your-secret-key` | Yes (production) |
| `JWT_REFRESH_SECRET` | Secret key for JWT refresh tokens | - | Yes |
| `JWT_EXPIRES_IN_MS` | Access token expiration time in milliseconds | `3600000` (1 hour) | Yes |
| `JWT_REFRESH_EXPIRES_IN_MS` | Refresh token expiration time in milliseconds | `604800000` (7 days) | Yes |
| `REFRESH_REUSE_GRACE_SECONDS` | Seconds after a rotation during which reusing the old refresh token gets 401 without revoking the session | `0` (off: any reuse revokes the session) | No |
| `LOGIN_MAX_FAILURES` | Failed logins for one email (from any IP) after which its logins get 429 with `Retry-After` | `5` | No |
| `LOGIN_FAILURE_WINDOW_SECONDS` | Window in which failed logins are counted; a successful login resets the count | `900` | No |
| `LOGIN_LOCKOUT_SECONDS` | First lock; each further failure doubles it | `60` | No |
| `LOGIN_LOCKOUT_MAX_SECONDS` | Upper bound of the lock | `900` | No |

## Email

Verification emails are sent over SMTP. Locally, `docker compose up -d mailpit`
catches them (web UI at http://localhost:8025).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `SMTP_HOST` | SMTP server host | - | Yes |
| `SMTP_PORT` | SMTP server port | - | Yes |
| `SMTP_SECURE` | `true` for implicit TLS (port 465); `false` uses STARTTLS when the server offers it | `false` | No |
| `SMTP_USER` / `SMTP_PASS` | SMTP credentials; set both or neither | - | No |
| `MAIL_FROM` | Sender, e.g. `Money <no-reply@example.com>` | - | Yes |
| `EMAIL_VERIFICATION_TTL_HOURS` | Lifetime of the link in the verification email; the link points to `${FRONTEND_URL}/verify-email?token=…` | `24` | No |

## Server Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port number | `3000` | No |
| `FRONTEND_URL` | Frontend origin: CORS allowed origin and the `Origin` accepted by web-mode `/auth` endpoints | `http://localhost:5173` | No |
| `DRAFT_RETENTION_DAYS` | Days an unconfirmed draft bill is kept before the daily cleanup (03:00 UTC) soft-deletes it; an invalid value stops startup | `30` | No |

## Batch Photo Parsing

`POST /households/{hid}/bills/parse-photos` stores 1–20 receipt photos and parses them
in a BullMQ worker (queue `bill-photo`); progress is sent over SSE
(`GET /households/{hid}/bills/events`). Needs Redis (`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`).

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `BILL_BATCH_ENABLED` | `true` registers the queue, the worker and the events hub. `false` touches no Redis for batches and the batch endpoints answer `503` "Batch photo parsing is disabled"; any other value stops startup | `true` | No |
| `BILL_BATCH_CONCURRENCY` | Photos one app process parses at once; every process running the app is a worker | `2` | No |
| `BILL_BATCH_ATTEMPTS` | Tries of one photo (exponential backoff from 5 s) before it becomes a failed bill with `ai_failed`. Rate-limit delays do not use a try | `3` | No |
| `BILL_BATCH_MAX_CONCURRENT_UPLOADS` | `POST bills/parse-photos` requests one app process accepts at once (each may hold up to 20 × 10 MB in memory while it is read). Past it the upload answers `503` with `Retry-After: 5` and "Too many batch uploads in progress, try again shortly", before reading the body or counting AI quota. Integer ≥ 1 | `2` | No |

## AWS S3 Configuration

**Added for bill photo upload functionality**

These variables are required for uploading bill photos to Amazon S3 storage.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AWS_REGION` | AWS region where the S3 bucket is located | `us-east-1` | No |
| `AWS_S3_BUCKET_NAME` | Name of the S3 bucket for storing bill photos | - | Yes |
| `AWS_ACCESS_KEY_ID` | AWS access key ID for S3 access | - | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS secret access key for S3 access | - | Yes |

### Setup Instructions

1. **Create an S3 Bucket:**
   - Log in to AWS Console
   - Navigate to S3 service
   - Create a new bucket (e.g., `accounting-bill-photos`)
   - Configure bucket permissions and CORS settings if needed

2. **Create IAM User:**
   - Go to IAM service in AWS Console
   - Create a new user with programmatic access
   - Attach a policy that allows S3 operations:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Action": [
             "s3:PutObject",
             "s3:GetObject",
             "s3:DeleteObject"
           ],
           "Resource": "arn:aws:s3:::your-bucket-name/*"
         }
       ]
     }
     ```
   - Save the Access Key ID and Secret Access Key

3. **Configure Environment Variables:**
   ```env
   AWS_REGION=us-east-1
   AWS_S3_BUCKET_NAME=accounting-bill-photos
   AWS_ACCESS_KEY_ID=your-access-key-id
   AWS_SECRET_ACCESS_KEY=your-secret-access-key
   ```

## AI Service Configuration

**Added for AI-powered bill photo parsing**

The application supports multiple AI providers for parsing bill data from uploaded photos. The AI service is easily configurable and can be switched without code changes.

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `AI_SERVICE_TYPE` | Type of AI service to use (`chatgpt`, `openai`) | `chatgpt` | No |
| `OPENAI_API_KEY` | OpenAI API key (required if using ChatGPT/OpenAI) | - | Yes (if using OpenAI) |

### Supported AI Services

#### ChatGPT/OpenAI (Default)

**Configuration:**
```env
AI_SERVICE_TYPE=chatgpt
OPENAI_API_KEY=sk-your-openai-api-key-here
```

**Setup Instructions:**

1. **Get OpenAI API Key:**
   - Sign up or log in to [OpenAI Platform](https://platform.openai.com/)
   - Navigate to API Keys section
   - Create a new secret key
   - Copy the API key (it will only be shown once)

2. **Configure Environment Variables:**
   ```env
   AI_SERVICE_TYPE=chatgpt
   OPENAI_API_KEY=sk-your-openai-api-key-here
   ```

3. **Note:**
   - The AI service uses GPT-4o model for vision capabilities
   - Ensure your OpenAI account has sufficient credits
   - The API key should be kept secure and never committed to version control

#### Adding New AI Services

To add support for additional AI providers (e.g., Anthropic Claude, Google Gemini):

1. Create a new service class implementing `IAIService` interface
2. Add the service to `ai.service.factory.ts`
3. Update the switch statement to include the new provider
4. Add required environment variables to this documentation

Example:
```typescript
// In ai.service.factory.ts
case 'anthropic':
  return {
    provide: AI_SERVICE_TOKEN,
    useClass: AnthropicAIService,
  };
```

## Complete .env.example

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=accounting

# JWT Authentication
JWT_SECRET=your-secret-key-change-in-production
JWT_REFRESH_SECRET=your-refresh-secret-key-change-in-production
JWT_EXPIRES_IN_MS=3600000
JWT_REFRESH_EXPIRES_IN_MS=604800000

# Server Configuration
PORT=3000
FRONTEND_URL=http://localhost:5173

# AWS S3 Configuration (for bill photo uploads)
AWS_REGION=us-east-1
AWS_S3_BUCKET_NAME=your-s3-bucket-name
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key

# AI Service Configuration (for bill photo parsing)
AI_SERVICE_TYPE=chatgpt
OPENAI_API_KEY=your-openai-api-key

# Batch photo parsing (needs Redis)
BILL_BATCH_ENABLED=true
BILL_BATCH_CONCURRENCY=2
BILL_BATCH_ATTEMPTS=3
```

## Security Notes

- **Never commit `.env` files to version control**
- Use strong, unique values for `JWT_SECRET` and `JWT_REFRESH_SECRET` in production
- Rotate AWS credentials and API keys regularly
- Use environment-specific values (development, staging, production)
- Consider using a secrets management service (AWS Secrets Manager, HashiCorp Vault) for production deployments

