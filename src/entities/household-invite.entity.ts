import {
  Entity,
  Property,
  BeforeCreate,
  ManyToOne,
  Index,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Household } from './household.entity';
import { User } from './user.entity';

@Entity({ tableName: 'household_invites' })
@Index({
  name: 'household_invites_household_id_index',
  properties: ['household'],
})
@Index({
  name: 'household_invites_invited_by_index',
  properties: ['invited_by'],
})
export class HouseholdInvite extends BaseEntity {
  @ManyToOne(() => Household, { nullable: false, deleteRule: 'cascade' })
  household!: Household;

  @Property({ type: 'varchar', length: 255, nullable: false })
  invitee_email!: string;

  @ManyToOne(() => User, { nullable: false, fieldName: 'invited_by' })
  invited_by!: User;

  /** SHA-256 hex of the raw token. Raw token is returned to client once, never persisted. */
  @Property({ type: 'varchar', length: 64, nullable: false, unique: true })
  token_hash!: string;

  @Property({
    type: 'varchar',
    length: 20,
    nullable: false,
    default: 'pending',
  })
  status: 'pending' | 'accepted' | 'revoked' = 'pending';

  @Property({ type: 'timestamptz', nullable: false })
  expires_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @BeforeCreate()
  beforeCreate() {
    this.created_at = new Date();
  }
}
