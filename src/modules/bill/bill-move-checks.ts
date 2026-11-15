import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { isUUID } from 'class-validator';
import { BillStatus } from '../../types/bill-status.enum';
import { MoveBillConflictDto, MoveConflictReason } from './dto/move-bills.dto';

/** Statuses a bill can be moved in; failed and duplicate ones stay. */
const MOVABLE: readonly string[] = [BillStatus.DRAFT, BillStatus.CONFIRMED];

/** Reasons in the order the 409 lists them for one bill. */
const REASONS = Object.values(MoveConflictReason);

/** A bill row locked for the move. */
export interface LockedBill {
  id: string;
  household_id: string;
  status: string;
  image_sha256: string | null;
  client_batch_id: string | null;
  client_batch_index: number | null;
  market_id: string | null;
}

/** The request being checked and the bills locked for it. */
interface MoveCheck {
  source: string;
  target: string;
  /** The requested ids, in the order of the request. */
  order: string[];
  locked: LockedBill[];
}

/**
 * The locked bills still in the source, once every requested bill is found
 * (else 404) and each of them can be moved (else 409, listing them all).
 * The other bills are in the target already: an earlier request moved them.
 */
export async function billsToMove(
  em: EntityManager,
  check: MoveCheck,
): Promise<LockedBill[]> {
  const found = new Set(check.locked.map((b) => b.id));
  const missing = check.order.filter((id) => !found.has(id));
  if (missing.length) {
    throw new NotFoundException({
      statusCode: 404,
      message: 'Some bills were not found',
      bill_ids: missing,
    });
  }
  const bills = check.locked.filter((b) => b.household_id === check.source);
  if (!bills.length) return bills;
  const conflicts = await findConflicts(em, check.target, bills);
  if (conflicts.length) {
    throw new ConflictException({
      statusCode: 409,
      message: 'Some bills cannot be moved',
      conflicts: sortConflicts(check.order, conflicts),
    });
  }
  return bills;
}

/**
 * Why each of the bills cannot be moved, one entry per reason: a status
 * other than draft or confirmed, a live duplicate pointing at it, a live
 * target draft of the same photo, a target bill (deleted ones too) of the
 * same client batch row. One query for the batch.
 */
async function findConflicts(
  em: EntityManager,
  target: string,
  bills: LockedBill[],
): Promise<MoveBillConflictDto[]> {
  const ids = uuids(bills.map((b) => b.id));
  const found = await execRows<MoveBillConflictDto>(
    em,
    `SELECT DISTINCT d.duplicate_of_id AS id, '${MoveConflictReason.HAS_DUPLICATES}' AS reason
     FROM   bills d
     WHERE  d.duplicate_of_id = ANY(?::uuid[])
       AND  d.status = '${BillStatus.DUPLICATE}' AND d.deleted_at IS NULL
     UNION ALL
     SELECT b.id, '${MoveConflictReason.DRAFT_IMAGE_CONFLICT}'
     FROM   bills b
     WHERE  b.id = ANY(?::uuid[]) AND b.status = '${BillStatus.DRAFT}'
       AND  EXISTS (SELECT 1 FROM bills t
                    WHERE t.household_id = ? AND t.status = '${BillStatus.DRAFT}'
                      AND t.deleted_at IS NULL AND t.image_sha256 = b.image_sha256)
     UNION ALL
     SELECT b.id, '${MoveConflictReason.CLIENT_BATCH_CONFLICT}'
     FROM   bills b
     WHERE  b.id = ANY(?::uuid[]) AND b.client_batch_id IS NOT NULL
       AND  EXISTS (SELECT 1 FROM bills t
                    WHERE t.household_id = ? AND t.client_batch_id = b.client_batch_id
                      AND t.client_batch_index = b.client_batch_index)`,
    [ids, ids, target, ids, target],
  );
  return [
    ...bills
      .filter((b) => !MOVABLE.includes(b.status))
      .map((b) => ({
        id: b.id,
        reason: MoveConflictReason.STATUS_NOT_MOVABLE,
      })),
    ...found,
  ];
}

/** The conflicts in the order of the request, then of the reasons. */
function sortConflicts(
  order: string[],
  conflicts: MoveBillConflictDto[],
): MoveBillConflictDto[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  return conflicts.sort(
    (x, y) =>
      (pos.get(x.id) ?? 0) - (pos.get(y.id) ?? 0) ||
      REASONS.indexOf(x.reason) - REASONS.indexOf(y.reason),
  );
}

/** Rows of a raw query, in the transaction of `em`. */
export async function execRows<T>(
  em: EntityManager,
  query: string,
  params: unknown[],
): Promise<T[]> {
  return (await em
    .getConnection()
    .execute(query, params, 'all', em.getTransactionContext())) as T[];
}

/**
 * A uuid[] literal: knex would expand a bound array into one placeholder
 * per value. It is passed as a bound parameter, and every element is checked
 * to be a uuid (or null) here, so nothing else can reach the literal.
 */
export function uuids(ids: (string | null)[]): string {
  for (const id of ids) {
    if (id !== null && !isUUID(id)) throw new Error(`Not a uuid: ${id}`);
  }
  return `{${ids.map((id) => id ?? 'NULL').join(',')}}`;
}
