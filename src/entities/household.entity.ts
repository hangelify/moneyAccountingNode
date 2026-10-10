import {
  Entity,
  Property,
  BeforeCreate,
  ManyToOne,
  OneToMany,
  Collection,
  Index,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { HouseholdMember } from './household-member.entity';
import { HouseholdInvite } from './household-invite.entity';

@Entity({ tableName: 'households' })
@Index({ name: 'households_created_by_index', properties: ['created_by'] })
export class Household extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  name!: string;

  @ManyToOne(() => User, { nullable: false, fieldName: 'created_by' })
  created_by!: User;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @OneToMany(() => HouseholdMember, (m) => m.household)
  members = new Collection<HouseholdMember>(this);

  @OneToMany(() => HouseholdInvite, (i) => i.household)
  invites = new Collection<HouseholdInvite>(this);

  @BeforeCreate()
  beforeCreate() {
    this.created_at = new Date();
  }
}
