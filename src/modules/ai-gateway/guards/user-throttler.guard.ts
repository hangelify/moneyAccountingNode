import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { AI_USAGE_LIMITS } from '../internal/ai-usage-limits';
import type { AiUsageLimits } from '../internal/ai-usage-limits';
import type { Response } from 'express';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Per-user limits on AI-backed routes (`ai-minute`, `ai-day`). The global
 * ThrottlerGuard runs before authentication and can only count by IP, so
 * this guard must be listed after JwtAuthGuard. Its throttlers replace the
 * module-wide ones, and its counters are shared by every route it guards.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(AI_USAGE_LIMITS) private readonly limits: AiUsageLimits,
  ) {
    super(options, storage, reflector);
  }

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [
      { name: 'ai-minute', ttl: MINUTE_MS, limit: this.limits.userPerMinute },
      { name: 'ai-day', ttl: DAY_MS, limit: this.limits.userPerDay },
    ];
    // Module-wide overrides would count by IP again.
    this.commonOptions.getTracker = this.getTracker.bind(this);
    this.commonOptions.generateKey = this.generateKey.bind(this);
  }

  protected override getTracker(req: Record<string, any>): Promise<string> {
    const id = (req.user as { id?: string } | undefined)?.id;
    if (!id) {
      throw new Error(
        'UserThrottlerGuard needs an authenticated user; list it after JwtAuthGuard',
      );
    }
    return Promise.resolve(`user:${id}`);
  }

  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return `user-throttler:${name}:${tracker}`;
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const res = this.getRequestResponse(context).res as Response;
    res.header('Retry-After', String(detail.timeToBlockExpire));
    const period = detail.ttl >= DAY_MS ? '24 hours' : 'minute';
    throw new ThrottlerException(
      `AI request limit reached: ${detail.limit} per ${period}. Try again in ${detail.timeToBlockExpire} s.`,
    );
  }
}
