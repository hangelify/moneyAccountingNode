import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  ManyToOne,
} from '@mikro-orm/decorators/legacy';
import { Household } from './household.entity';
import { User } from './user.entity';

@Entity({ tableName: 'household_members' })
export class HouseholdMember {
  @ManyToOne(() => Household, {
    primary: true,
    nullable: false,
    deleteRule: 'cascade',
  })
  household!: Rel<Household>;

  @ManyToOne(() => User, {
    primary: true,
    nullable: false,
    deleteRule: 'cascade',
  })
  user!: Rel<User>;

  @Property({ type: 'varchar', length: 20, nullable: false, default: 'member' })
  role: 'owner' | 'member' = 'member';

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  joined_at!: Date;

  @BeforeCreate()
  beforeCreate() {
    this.joined_at = new Date();
  }
}
