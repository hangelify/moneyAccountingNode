import type { FailureKind } from './internal/error-classifier';

export class AiGatewayExhaustedError extends Error {
  constructor(
    public readonly parentId: string,
    public readonly lastError: unknown,
    /** Why each attempt failed, in order; a provider skipped for lack of time counts as `unavailable`. */
    public readonly failures: FailureKind[] = [],
  ) {
    super(`AI gateway exhausted all providers for request ${parentId}`);
    this.name = 'AiGatewayExhaustedError';
  }
}

export class NoCapableProviderError extends Error {
  constructor(
    public readonly taskName: string,
    /** The `ai_requests` id, when the request was already audited. */
    public readonly requestId: string | null = null,
  ) {
    super(
      `No configured provider supports the capabilities required by task '${taskName}'`,
    );
    this.name = 'NoCapableProviderError';
  }
}

/** The task input failed its schema: a caller bug, caught before any audit row. */
export class AiInputInvalidError extends Error {
  constructor(
    public readonly taskName: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid input for AI task '${taskName}'`);
    this.name = 'AiInputInvalidError';
  }
}

/** The request image could not be stored, so no provider was called. */
export class AiImageStorageError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly cause: unknown,
  ) {
    super(`Storing the image of AI request ${requestId} failed`);
    this.name = 'AiImageStorageError';
  }
}

export class AiBudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly budgetUsd: number,
  ) {
    super(
      `Daily AI budget exceeded: spent $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} in the last 24 hours`,
    );
    this.name = 'AiBudgetExceededError';
  }
}

export class AiCapacityExceededError extends Error {
  constructor(
    public readonly maxConcurrency: number,
    public readonly retryAfterSec: number,
  ) {
    super(`All ${maxConcurrency} AI call slots are busy`);
    this.name = 'AiCapacityExceededError';
  }
}
