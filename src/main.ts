import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.setup';
import { parseTrustProxy } from './config/trust-proxy';

async function bootstrap() {
  // Parsed before the app is created so an invalid value fails startup fast.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app, { trustProxy });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(
    `Swagger documentation available at: http://localhost:${port}/api`,
  );
}
void bootstrap();
