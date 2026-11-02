export enum BillStatus {
  DRAFT = 'draft',
  CONFIRMED = 'confirmed',
  /** A copy of another bill (`duplicate_of`); never counted. */
  DUPLICATE = 'duplicate',
  /** A photo that could not be parsed; carries `parse_error_code`, never counted. */
  FAILED = 'failed',
}
