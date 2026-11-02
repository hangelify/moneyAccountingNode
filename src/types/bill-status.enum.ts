export enum BillStatus {
  DRAFT = 'draft',
  CONFIRMED = 'confirmed',
  /** A copy of another bill (`duplicate_of`); never counted. */
  DUPLICATE = 'duplicate',
}
