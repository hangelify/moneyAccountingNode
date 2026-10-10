import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { User } from '../../entities/user.entity';
import { UserProfileDto } from './dto/user-profile.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
  ) {}

  async getProfile(userId: string): Promise<UserProfileDto> {
    const user = await this.userRepository.findOne(
      { id: userId },
      {
        fields: [
          'id',
          'email',
          'first_name',
          'last_name',
          'username',
          'currency',
          'language_code',
          'created_at',
          'updated_at',
        ],
      },
    );
    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      username: user.username,
      currency: user.currency,
      language_code: user.language_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }
}
