import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { applyTrustProxy, TrustProxySetting } from './config/trust-proxy';

export interface AppSetupOptions {
  trustProxy: TrustProxySetting;
}

// Everything main.ts applies to the app besides listen(); e2e tests call it
// too, so they run against the same pipes, filter, CORS and proxy settings.
export function configureApp(
  app: NestExpressApplication,
  { trustProxy }: AppSetupOptions,
): void {
  // req.ip (rate limiting, session/audit IPs) only honours X-Forwarded-For
  // from proxies listed in TRUST_PROXY; by default the header is ignored.
  applyTrustProxy(app, trustProxy);

  // Web clients send the refresh token as an HttpOnly cookie (/auth only).
  app.use(cookieParser());

  // Enable CORS
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger configuration
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Accounting API')
    .setDescription(
      'Family Accounting Application API Documentation. Authentication is ' +
        'session-based with JWT: log in for an access token and send it as ' +
        'a Bearer token. Browsers receive the refresh token as an HttpOnly ' +
        'cookie scoped to /auth; native apps send X-Client-Type: mobile ' +
        '(without Origin) to receive it in the response body.',
    )
    .setVersion('1.0')
    .addTag('auth', 'Authentication endpoints')
    .addTag('app', 'Application endpoints')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Access token from /auth/login or /auth/refresh',
        in: 'header',
      },
      'JWT-auth', // This name here is important for matching up with @ApiBearerAuth() in your controller!
    )
    .addCookieAuth(
      'refresh_token',
      {
        type: 'apiKey',
        in: 'cookie',
        description: 'HttpOnly refresh token cookie set by web-mode login',
      },
      'refresh-cookie',
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // Keep authorization token after page refresh
    },
  });
}
