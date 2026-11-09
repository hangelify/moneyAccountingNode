import type { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';
import type { BillParseErrorCode } from '../../../types/bill-parse-error.enum';

export const BILL_EVENTS_PATTERN = 'bill-events:*';
const CHANNEL_PREFIX = 'bill-events:';

export function billEventsChannel(householdId: string): string {
  return `${CHANNEL_PREFIX}${householdId}`;
}

/** The household of a `bill-events:{householdId}` channel, or null. */
export function householdOfChannel(channel: string): string | null {
  return channel.startsWith(CHANNEL_PREFIX)
    ? channel.slice(CHANNEL_PREFIX.length) || null
    : null;
}

export type ItemEvent = {
  batch_id: string;
  item_id: string;
  position: number;
  status: BillBatchItemStatus;
  created_by_user_id: string | null;
  bill_id?: string;
  parse_error_code?: BillParseErrorCode;
  parse_error_message?: string;
};

export type BatchCompletedEvent = {
  batch_id: string;
  total: number;
  done: number;
  failed: number;
  created_by_user_id: string | null;
};

export type BillEvent =
  | { type: 'item.processing' | 'item.done' | 'item.failed'; data: ItemEvent }
  | { type: 'batch.completed'; data: BatchCompletedEvent };
