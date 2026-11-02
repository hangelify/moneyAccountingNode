export type LlmImage = {
  data: Buffer;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
};

export type LlmMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string; images?: LlmImage[] }
  | { role: 'assistant'; text: string };

export interface LlmRequest {
  messages: LlmMessage[];
  jsonSchema?: object;
  modelOverride?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  json?: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Provider's own stop/finish reason, e.g. 'end_turn', 'stop', 'length'. */
  stopReason?: string;
}
