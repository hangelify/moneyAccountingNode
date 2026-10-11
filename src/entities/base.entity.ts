import { PrimaryKey } from '@mikro-orm/decorators/legacy';

/**
 * Base entity that provides ID for all tables.
 * Uses UUID as primary key type.
 */
export abstract class BaseEntity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;
}
