import { Logger } from '@nestjs/common';
import { Bill } from '../../entities/bill.entity';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateService } from '../exchange-rate';

/**
 * Saves the rates of a batch's days once it has committed. Bills without a
 * currency have no rate to save. Never throws: the bills stand even if the
 * rate API is down.
 */
export async function warmBillRates(
  deps: { rates: Pick<ExchangeRateService, 'ensureDays'>; log: Logger },
  householdCurrency: Currency,
  bills: Pick<Bill, 'currency' | 'bill_date'>[],
  what: string,
): Promise<void> {
  const days = [
    ...new Set(
      bills
        .filter((b) => b.currency && b.currency !== householdCurrency)
        .map((b) => b.bill_date),
    ),
  ];
  if (!days.length) return;
  try {
    await deps.rates.ensureDays(days, { max: days.length });
  } catch (e) {
    deps.log.warn(`Could not save rates for ${what}: ${(e as Error).message}`);
  }
}
