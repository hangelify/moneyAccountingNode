export class AiGatewayExhaustedError extends Error {
  constructor(
    public readonly parentId: string,
    public readonly lastError: unknown,
  ) {
    super(`AI gateway exhausted all providers for request ${parentId}`);
    this.name = 'AiGatewayExhaustedError';
  }
}

export class NoCapableProviderError extends Error {
  constructor(public readonly taskName: string) {
    super(
      `No configured provider supports the capabilities required by task '${taskName}'`,
    );
    this.name = 'NoCapableProviderError';
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
