import * as bcrypt from 'bcrypt';
import { PASSWORD_HASH_COST, PasswordService } from './password.service';

// Wrap the real bcrypt so calls can be counted (its exports are not spy-able).
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  const compare = (data: string, hash: string): Promise<boolean> =>
    actual.compare(data, hash);
  return { ...actual, compare: jest.fn(compare) };
});

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with the configured bcrypt cost', async () => {
    const hash = await service.hash('correct horse');

    expect(PASSWORD_HASH_COST).toBe(12);
    expect(bcrypt.getRounds(hash)).toBe(PASSWORD_HASH_COST);
    expect(await bcrypt.compare('correct horse', hash)).toBe(true);
  });

  it('verifies a matching password and flags a weaker hash for rehash', async () => {
    const legacy = await bcrypt.hash('correct horse', 10);

    await expect(service.verify('correct horse', legacy)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it('does not flag a hash at the current cost', async () => {
    const current = await service.hash('correct horse');

    await expect(service.verify('correct horse', current)).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
  });

  it('rejects a wrong password without asking for a rehash', async () => {
    const legacy = await bcrypt.hash('correct horse', 10);

    await expect(service.verify('wrong', legacy)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('pads a failed check of a weaker hash to the work of the current cost', async () => {
    const legacy = await bcrypt.hash('correct horse', 10);
    const compare = jest.mocked(bcrypt.compare);
    compare.mockClear();

    await service.verify('wrong', legacy);

    // 2^12 = 4 * 2^10: the real comparison plus three dummy ones at cost 10.
    const costs = compare.mock.calls.map(([, hash]) => bcrypt.getRounds(hash));
    expect(costs).toEqual([10, 10, 10, 10]);
  });

  it('does not pad a successful check of a weaker hash', async () => {
    const legacy = await bcrypt.hash('correct horse', 10);
    const compare = jest.mocked(bcrypt.compare);
    compare.mockClear();

    await service.verify('correct horse', legacy);

    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('spends one bcrypt comparison on an unknown user', async () => {
    await expect(service.verifyAgainstDummy('anything')).resolves.toBe(false);
  });
});
