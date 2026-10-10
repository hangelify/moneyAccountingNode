import { NotFoundException } from '@nestjs/common';
import { EntityRepository } from '@mikro-orm/core';
import { UserService } from './user.service';
import { User } from '../../entities/user.entity';

describe('UserService', () => {
  it('throws NotFoundException when the user does not exist', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as EntityRepository<User>;
    const service = new UserService(repo);

    await expect(service.getProfile('missing-user')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
