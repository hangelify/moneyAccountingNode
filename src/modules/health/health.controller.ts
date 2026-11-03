import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { EntityManager } from '@mikro-orm/core';
import type { Response } from 'express';

const DB_TIMEOUT_MS = 1_000;

export interface HealthStatus {
  status: 'ok' | 'unavailable';
}

/**
 * Readiness probe for deploys: 200 only when PostgreSQL answers `select 1`
 * within a second. The 503 body never carries the database error.
 */
@ApiTags('app')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get()
  @ApiOperation({ summary: 'Readiness check (database reachable)' })
  @ApiResponse({ status: 200, description: '{"status":"ok"}' })
  @ApiResponse({ status: 503, description: '{"status":"unavailable"}' })
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('db timeout')), DB_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        this.em.getConnection().execute('select 1'),
        timeout,
      ]);
      return { status: 'ok' };
    } catch {
      res.status(503);
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
