export enum BillBatchItemStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  /** Parsed into a draft bill. */
  DONE = 'done',
  /** Kept as a failed bill. */
  FAILED = 'failed',
}
