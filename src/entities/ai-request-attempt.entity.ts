import {
  Entity,
  Property,
  BeforeCreate,
  ManyToOne,
  Index,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { AiRequest } from './ai-request.entity';

export enum AiAttemptStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export enum AiAttemptErrorCode {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  SERVER_ERROR = 'SERVER_ERROR',
  SCHEMA_INVALID = 'SCHEMA_INVALID',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  UNKNOWN = 'UNKNOWN',
}

@Entity({ tableName: 'ai_request_attempts' })
export class AiRequestAttempt extends BaseEntity {
  @ManyToOne(() => AiRequest, { nullable: false })
  @Index()
  ai_request!: AiRequest;

  @Property({ type: 'integer', nullable: false })
  attempt_number!: number;

  @Property({ type: 'varchar', length: 32, nullable: false })
  provider_name!: string;

  @Property({ type: 'varchar', length: 128, nullable: false })
  model!: string;

  @Enum({
    items: () => AiAttemptStatus,
    type: 'enum',
    nativeEnumName: 'ai_attempt_status_enum',
    nullable: false,
  })
  status!: AiAttemptStatus;

  @Enum({
    items: () => AiAttemptErrorCode,
    type: 'enum',
    nativeEnumName: 'ai_attempt_error_code_enum',
    nullable: true,
  })
  error_code?: AiAttemptErrorCode;

  @Property({ type: 'text', nullable: true })
  error_message?: string;

  @Property({ type: 'text', nullable: true })
  raw_response_text?: string;

  @Property({ type: 'jsonb', nullable: true })
  parsed_json?: unknown;

  @Property({ type: 'integer', nullable: false })
  latency_ms!: number;

  @Property({ type: 'integer', nullable: true })
  input_tokens?: number;

  @Property({ type: 'integer', nullable: true })
  output_tokens?: number;

  @Property({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  input_cost_usd?: number;

  @Property({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  output_cost_usd?: number;

  @Property({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  total_cost_usd?: number;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @BeforeCreate()
  beforeCreate() {
    this.created_at = new Date();
  }
}
