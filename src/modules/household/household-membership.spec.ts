import { EntityRepository } from '@mikro-orm/core';
import { findHouseholdRole } from './household-membership';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';

function makeRepos(): {
  households: EntityRepository<Household>;
  members: EntityRepository<HouseholdMember>;
} {
  const households = {
    findOne: jest.fn(),
  } as unknown as EntityRepository<Household>;
  const members = {
    findOne: jest.fn(),
  } as unknown as EntityRepository<HouseholdMember>;
  return { households, members };
}

const HID = '11111111-1111-4111-8111-111111111111';

describe('findHouseholdRole', () => {
  it('returns null when the household is missing or deleted', async () => {
    const { households, members } = makeRepos();
    (households.findOne as jest.Mock).mockResolvedValue(null);
    await expect(
      findHouseholdRole(households, members, HID, 'user-1'),
    ).resolves.toBeNull();
    expect(members.findOne).not.toHaveBeenCalled();
  });

  it('returns null when the user is not a member', async () => {
    const { households, members } = makeRepos();
    (households.findOne as jest.Mock).mockResolvedValue({ id: HID });
    (members.findOne as jest.Mock).mockResolvedValue(null);
    await expect(
      findHouseholdRole(households, members, HID, 'user-1'),
    ).resolves.toBeNull();
  });

  it('returns the member role', async () => {
    const { households, members } = makeRepos();
    (households.findOne as jest.Mock).mockResolvedValue({ id: HID });
    (members.findOne as jest.Mock).mockResolvedValue({ role: 'owner' });
    await expect(
      findHouseholdRole(households, members, HID, 'user-1'),
    ).resolves.toBe('owner');
    expect(households.findOne).toHaveBeenCalledWith({
      id: HID,
      deleted_at: null,
    });
    expect(members.findOne).toHaveBeenCalledWith({
      household: { id: HID },
      user: { id: 'user-1' },
    });
  });
});
