import { Logger } from '@nestjs/common';
import { Currency } from '../../types/currency.enum';
import { warmBillRates } from './bill-rates';

describe('warmBillRates', () => {
  const log = { warn: jest.fn() } as unknown as Logger;
  const ensureDays = jest.fn();
  const rates = { ensureDays };

  beforeEach(() => {
    jest.clearAllMocks();
    ensureDays.mockResolvedValue({ missing: [] });
  });

  it('asks once for the unique days of bills in a foreign currency', async () => {
    await warmBillRates(
      { rates, log },
      Currency.EUR,
      [
        { currency: Currency.USD, bill_date: '2026-11-01' },
        { currency: Currency.USD, bill_date: '2026-11-01' },
        { currency: Currency.EUR, bill_date: '2026-11-02' },
        { currency: undefined, bill_date: '2026-11-03' },
      ],
      'a test',
    );
    expect(ensureDays).toHaveBeenCalledTimes(1);
    expect(ensureDays).toHaveBeenCalledWith(['2026-11-01'], { max: 1 });
  });

  it('does nothing when every bill is in the household currency', async () => {
    await warmBillRates(
      { rates, log },
      Currency.EUR,
      [{ currency: Currency.EUR, bill_date: '2026-11-01' }],
      'a test',
    );
    expect(ensureDays).not.toHaveBeenCalled();
  });

  it('logs and swallows a provider error', async () => {
    ensureDays.mockRejectedValue(new Error('down'));
    await expect(
      warmBillRates(
        { rates, log },
        Currency.EUR,
        [{ currency: Currency.USD, bill_date: '2026-11-01' }],
        'a test',
      ),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
