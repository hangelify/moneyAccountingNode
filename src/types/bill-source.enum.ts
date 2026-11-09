/** Where a bill came from. */
export enum BillSource {
  /** Read from a receipt photo by the AI parser. */
  PHOTO = 'photo',
  /** Typed in by hand. */
  MANUAL = 'manual',
  /** Imported from a bank statement. */
  BANK = 'bank',
}
