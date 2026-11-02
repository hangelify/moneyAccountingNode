import type { Rel } from '@mikro-orm/core';
import { Entity, Property, ManyToOne } from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

@Entity({ tableName: 'sessions' })
export class Session extends BaseEntity {
  @ManyToOne(() => User, { nullable: false, deleteRule: 'cascade' })
  user!: Rel<User>;

  @Property({ type: 'varchar', length: 45, nullable: true })
  ip_address?: string | null;

  @Property({ type: 'text', nullable: true })
  user_agent?: string;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false })
  absolute_expires_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  last_activity_at?: Date;

  @Property({ type: 'boolean', nullable: false, default: true })
  is_active!: boolean;
}
