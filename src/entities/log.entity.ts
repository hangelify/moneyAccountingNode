import { Entity, Property, ManyToOne, Index, Enum } from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export enum LogSource {
  BACKEND = 'BACKEND',
  FRONTEND = 'FRONTEND',
  API = 'API',
  AUTH = 'AUTH',
  DATABASE = 'DATABASE',
}

@Entity({ tableName: 'logs' })
export class Log extends BaseEntity {
  @Enum({
    items: () => LogLevel,
    type: 'enum',
    nativeEnumName: 'log_level_enum',
    nullable: false,
  })
  @Index()
  level!: LogLevel;

  @Enum({
    items: () => LogSource,
    type: 'enum',
    nativeEnumName: 'log_source_enum',
    nullable: false,
  })
  @Index()
  source!: LogSource;

  @Property({ type: 'varchar', length: 255, nullable: true })
  @Index()
  context?: string;

  @Property({ type: 'text', nullable: false })
  message!: string;

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @ManyToOne(() => User, { nullable: true, deleteRule: 'set null' })
  user?: User;

  @Property({ type: 'varchar', length: 45, nullable: true })
  ip_address?: string | null;

  @Property({ type: 'text', nullable: true })
  user_agent?: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  endpoint?: string;

  @Property({ type: 'varchar', length: 10, nullable: true })
  http_method?: string;

  @Property({ type: 'integer', nullable: true })
  status_code?: number;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  @Index()
  created_at!: Date;
}
