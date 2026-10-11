import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  ManyToOne,
  OneToMany,
  Index,
  Enum,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';
import { Household } from './household.entity';
import { AiRequestAttempt } from './ai-request-attempt.entity';

export enum AiRequestStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

@Entity({ tableName: 'ai_requests' })
// Daily AI budget: SUM(total_cost_usd) per user over the last 24 hours.
@Index({ properties: ['user', 'created_at'] })
// In place of a (status) index (3 values): only in-flight requests, for
// finding stuck PENDING ones.
@Index({
  name: 'ai_requests_pending_index',
  expression: `create index "ai_requests_pending_index" on "ai_requests" ("created_at") where "status" = 'PENDING'`,
})
// Retention scrub: requests still holding raw payloads, by age.
@Index({
  name: 'ai_requests_unscrubbed_created_index',
  expression: `create index "ai_requests_unscrubbed_created_index" on "ai_requests" ("created_at") where "prompt" is not null`,
})
export class AiRequest extends BaseEntity {
  @Property({ type: 'varchar', length: 128, nullable: false })
  task_name!: string;

  @ManyToOne(() => User, { nullable: true, deleteRule: 'set null' })
  user?: Rel<User>;

  @ManyToOne(() => Household, { nullable: true, deleteRule: 'set null' })
  @Index()
  household?: Rel<Household>;

  @Enum({
    items: () => AiRequestStatus,
    type: 'enum',
    nativeEnumName: 'ai_request_status_enum',
    nullable: false,
  })
  status!: AiRequestStatus;

  @Property({ type: 'jsonb', nullable: false })
  required_capabilities!: string[];

  @Property({ type: 'jsonb', nullable: true })
  image_s3_keys?: string[];

  // Null once the retention job has scrubbed the raw payloads.
  @Property({ type: 'jsonb', nullable: true })
  prompt?: { messages: Array<{ role: string; text: string }> } | null;

  @Property({ type: 'jsonb', nullable: true })
  final_output?: unknown;

  @Property({ type: 'text', nullable: true })
  error_message?: string;

  @Property({ type: 'uuid', nullable: true })
  chosen_attempt_id?: string;

  @Property({ type: 'integer', nullable: true })
  total_latency_ms?: number;

  @Property({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  total_cost_usd?: number;

  @OneToMany(() => AiRequestAttempt, (a) => a.ai_request)
  attempts = new Collection<AiRequestAttempt>(this);

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  @Index()
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @BeforeCreate()
  beforeCreate() {
    this.created_at = new Date();
    this.updated_at = new Date();
  }

  @BeforeUpdate()
  beforeUpdate() {
    this.updated_at = new Date();
  }
}
