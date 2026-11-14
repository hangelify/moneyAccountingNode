// Public API of the ai-gateway module.
// Other modules import from here, never from files inside the module.
// The Nest module is not exported here: import it from ./<m>.module, so
// loading this barrel never pulls the module graph (and its cycles) in.

export type { Env } from './internal/ai-call-config';
export type { AiUsageLimits } from './internal/ai-usage-limits';
export type { FailureKind } from './internal/error-classifier';
export type { AiTaskResult, TaskRequest } from './types/ai-task';
export type { Capability } from './types/capability';
export {
  AiBudgetExceededError,
  AiCapacityExceededError,
  AiGatewayExhaustedError,
  AiImageStorageError,
  AiInputInvalidError,
  NoCapableProviderError,
} from './errors';
export { UserThrottlerGuard } from './guards/user-throttler.guard';
export { readInt } from './internal/ai-call-config';
export { AI_USAGE_LIMITS } from './internal/ai-usage-limits';
export { toProviderJsonSchema } from './internal/provider-json-schema';
export { AiTask } from './types/ai-task';
export { AiGatewayService } from './ai-gateway.service';
export { AiUserQuota } from './ai-user-quota.service';
export { AnthropicProvider } from './providers/anthropic.provider';
export { DeepSeekProvider } from './providers/deepseek.provider';
export { OpenAiProvider } from './providers/openai.provider';
