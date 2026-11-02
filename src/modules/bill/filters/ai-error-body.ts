import { STATUS_CODES } from 'node:http';

/** Error body of the AI endpoints; see `AiErrorResponseDto`. */
export interface AiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  /** The `ai_requests` id, or null when the call failed before it was audited. */
  request_id: string | null;
}

export function aiErrorBody(
  statusCode: number,
  message: string,
  requestId: string | null,
): AiErrorBody {
  return {
    statusCode,
    error: STATUS_CODES[statusCode] ?? 'Error',
    message,
    request_id: requestId,
  };
}
