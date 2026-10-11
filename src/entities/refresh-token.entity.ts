import type { Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  ManyToOne,
  Index,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Session } from './session.entity';

@Entity({ tableName: 'refresh_tokens' })
export class RefreshToken extends BaseEntity {
  @ManyToOne(() => User, { nullable: false, deleteRule: 'cascade' })
  user!: Rel<User>;

  @ManyToOne(() => Session, { nullable: false, deleteRule: 'cascade' })
  @Index()
  session!: Rel<Session>;

  @Property({ type: 'varchar', length: 64, nullable: false, unique: true })
  @Index()
  token_hash!: string;

  @Property({ type: 'uuid', nullable: false, unique: true })
  @Index()
  jti!: string;

  @Property({ type: 'varchar', length: 45, nullable: true })
  ip_address?: string | null;

  @Property({ type: 'text', nullable: true })
  user_agent?: string;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false })
  expires_at!: Date;

  @Property({ type: 'boolean', nullable: false, default: false })
  is_revoked!: boolean;

  // Null for tokens revoked before the column existed.
  @Property({ type: 'timestamptz', nullable: true })
  revoked_at?: Date | null;
}
