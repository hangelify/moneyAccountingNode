import { readInt } from '../../ai-gateway/internal/ai-call-config';
import type { Env } from '../../ai-gateway/internal/ai-call-config';

export const BILL_PHOTO_QUEUE = 'bill-photo';
export const BILL_BATCH_ENV = Symbol('BILL_BATCH_ENV');
/** Provided instead of the batch services when BILL_BATCH_ENABLED=false. */
export const BILL_BATCH_DISABLED = Symbol('BILL_BATCH_DISABLED');

export interface BillBatchEnv {
  /** BILL_BATCH_ENABLED: register the queue, worker and events hub. */
  enabled: boolean;
  /** BILL_BATCH_CONCURRENCY: jobs one worker process runs at once. */
  concurrency: number;
  /** BILL_BATCH_ATTEMPTS: tries of one photo before it becomes a failed bill. */
  attempts: number;
}

function readEnabled(env: Env): boolean {
  const raw = env.BILL_BATCH_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(
    `Invalid BILL_BATCH_ENABLED='${env.BILL_BATCH_ENABLED}': expected 'true' or 'false'`,
  );
}

export function readBillBatchEnv(env: Env = process.env): BillBatchEnv {
  return {
    enabled: readEnabled(env),
    concurrency: readInt(env, 'BILL_BATCH_CONCURRENCY', 2, 1),
    attempts: readInt(env, 'BILL_BATCH_ATTEMPTS', 3, 1),
  };
}
