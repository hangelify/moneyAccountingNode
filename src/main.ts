import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.setup';
import { loadSwaggerOptions } from './config/swagger';
import { parseTrustProxy } from './config/trust-proxy';

async function bootstrap() {
  // Parsed before the app is created so an invalid value fails startup fast.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const swagger = loadSwaggerOptions();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, { trustProxy, swagger });
  // SIGTERM (PM2 restart, systemd stop) runs the onModuleDestroy hooks: the
  // batch worker finishes its jobs and Redis connections close cleanly.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  if (swagger.enabled) {
    console.log(
      `Swagger documentation available at: http://localhost:${port}/api`,
    );
  }
}
void bootstrap();
