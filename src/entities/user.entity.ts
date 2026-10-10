import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  Enum,
} from '@mikro-orm/core';
import { BaseEntity } from './base.entity';
import { Currency } from '../types/currency.enum';
import { LanguageCode } from '../types/language-code.enum';
import * as bcrypt from 'bcrypt';

export const PASSWORD_HASH_ROUNDS = 10;

@Entity({ tableName: 'users' })
export class User extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  first_name!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  last_name?: string;

  @Property({ type: 'varchar', length: 255, nullable: false, unique: true })
  email!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  username?: string;

  @Property({ type: 'varchar', length: 255, nullable: false, hidden: true })
  password!: string;

  @Enum({
    items: () => LanguageCode,
    type: 'enum',
    nativeEnumName: 'language_code_enum',
    nullable: true,
  })
  language_code?: LanguageCode;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: false,
    default: Currency.EUR,
  })
  currency!: Currency;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @BeforeCreate()
  async beforeCreate() {
    this.created_at = new Date();
    this.updated_at = new Date();
    if (this.password) {
      this.password = await bcrypt.hash(this.password, PASSWORD_HASH_ROUNDS);
    }
  }

  @BeforeUpdate()
  beforeUpdate() {
    this.updated_at = new Date();
  }

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }
}
