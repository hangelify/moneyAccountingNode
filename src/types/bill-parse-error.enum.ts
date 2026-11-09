/** Why a batch photo became a failed bill. */
export enum BillParseErrorCode {
  /** The image is not a receipt. */
  NOT_A_RECEIPT = 'not_a_receipt',
  /** The AI call failed or returned nothing usable. */
  AI_FAILED = 'ai_failed',
  /** The parsed receipt could not be saved as a draft. */
  SAVE_FAILED = 'save_failed',
}
