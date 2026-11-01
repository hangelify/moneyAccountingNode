import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type { Bill } from '../../entities/bill.entity';
import type { Currency } from '../../types/currency.enum';
import {
  rankCandidates,
  type CandidateRow,
  type DuplicateProbe,
} from './bill-duplicates';
import { PossibleDuplicateDto } from './dto/bill-duplicates.dto';

interface RawCandidate {
  id: string;
  amount: string;
  currency: Currency | null;
  bill_date: string;
  market_id: string | null;
  market_name: string | null;
  fiscal_register_id: string | null;
  fiscal_receipt_number: string | null;
  purchase_time: string | null;
  created_at: string;
  created_by_name: string | null;
}

@Injectable()
export class BillDuplicatesService {
  constructor(private readonly em: EntityManager) {}

  /** Live confirmed bills of the household that may be the same purchase as `probe`. */
  async findCandidates(
    householdId: string,
    probe: DuplicateProbe,
    opts: {
      excludeBillId?: string;
      dateToleranceDays?: number;
      limit?: number;
    } = {},
  ): Promise<PossibleDuplicateDto[]> {
    const dateToleranceDays = opts.dateToleranceDays ?? 0;
    const limit = opts.limit ?? 5;
    const params: unknown[] = [householdId];
    let exclude = '';
    if (opts.excludeBillId) {
      exclude = 'AND b.id <> ?';
      params.push(opts.excludeBillId);
    }
    // Same normalization as the ranking: trimmed, case-insensitive.
    const register = probe.fiscal_register_id ?? '';
    const receipt = probe.fiscal_receipt_number ?? '';
    params.push(
      register,
      receipt,
      register,
      receipt,
      probe.amount,
      probe.currency,
      probe.bill_date,
      dateToleranceDays,
      probe.bill_date,
      dateToleranceDays,
    );

    const raw = await this.fetchRaw(exclude, params);

    const rows: CandidateRow[] = raw.map((r) => ({
      ...r,
      amount: Number(r.amount),
    }));
    return rankCandidates(probe, rows, { dateToleranceDays, limit }).map(
      ({ row, match }) => ({
        id: row.id,
        bill_date: row.bill_date,
        total_amount: row.amount,
        currency: row.currency,
        market_name: row.market_name,
        created_by_name: row.created_by_name,
        match,
      }),
    );
  }

  probeOf(bill: Bill): DuplicateProbe {
    return {
      amount: Number(bill.amount),
      currency: bill.currency ?? null,
      bill_date: bill.bill_date,
      market_id: bill.market?.id ?? null,
      market_name: bill.market?.name ?? bill.market_name_raw ?? null,
      fiscal_register_id: bill.fiscal_register_id ?? null,
      fiscal_receipt_number: bill.fiscal_receipt_number ?? null,
      purchase_time: bill.purchase_time ?? null,
    };
  }

  private fetchRaw(
    exclude: string,
    params: unknown[],
  ): Promise<RawCandidate[]> {
    const conn = this.em.getConnection();
    return conn.execute(
      `SELECT b.id, b.amount::text AS amount, b.currency::text AS currency,
              b.bill_date::text AS bill_date, b.market_id,
              COALESCE(m.name, b.market_name_raw) AS market_name,
              b.fiscal_register_id, b.fiscal_receipt_number,
              to_char(b.purchase_time, 'HH24:MI') AS purchase_time,
              to_char(b.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
              u.first_name AS created_by_name
         FROM bills b
         LEFT JOIN markets m ON m.id = b.market_id
         LEFT JOIN users u ON u.id = b.created_by_user_id
        WHERE b.household_id = ?
          AND b.status = 'confirmed'
          AND b.deleted_at IS NULL
          ${exclude}
          AND (
            (nullif(trim(?), '') IS NOT NULL
              AND nullif(trim(?), '') IS NOT NULL
              AND lower(trim(b.fiscal_register_id)) = lower(trim(?))
              AND lower(trim(b.fiscal_receipt_number)) = lower(trim(?)))
            OR (b.amount = ?
              AND b.currency::text IS NOT DISTINCT FROM ?::text
              AND b.bill_date BETWEEN ?::date - ?::int AND ?::date + ?::int)
          )`,
      params,
    );
  }
}
