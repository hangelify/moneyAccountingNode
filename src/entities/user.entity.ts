import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  Enum,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { Currency } from '../types/currency.enum';
import { LanguageCode } from '../types/language-code.enum';

@Entity({ tableName: 'users' })
// Case-insensitive: one account per address whatever its case. Emails are
// also stored lowercased (see NormalizeEmail).
@Unique({
  name: 'users_email_lower_unique',
  expression:
    'create unique index "users_email_lower_unique" on "users" (lower("email"))',
})
@Unique({
  name: 'users_email_verification_token_hash_unique',
  expression:
    'create unique index "users_email_verification_token_hash_unique" on "users" ("email_verification_token_hash") where "email_verification_token_hash" is not null',
})
export class User extends BaseEntity {
  @Property({ type: 'varchar', length: 255, nullable: false })
  first_name!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  last_name?: string;

  @Property({ type: 'varchar', length: 255, nullable: false })
  email!: string;

  @Property({ type: 'varchar', length: 255, nullable: true })
  username?: string;

  // A bcrypt hash, set by PasswordService; the entity never hashes.
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

  /** NULL until the user opens the link from the verification email. */
  @Property({ type: 'timestamptz', nullable: true })
  email_verified_at?: Date | null;

  // SHA-256 of the one active verification token; the raw token is only in
  // the email.
  @Property({ type: 'varchar', length: 64, nullable: true, hidden: true })
  email_verification_token_hash?: string | null;

  @Property({ type: 'timestamptz', nullable: true, hidden: true })
  email_verification_expires_at?: Date | null;

  /** When the active token was emailed; drives the resend cooldown. */
  @Property({ type: 'timestamptz', nullable: true, hidden: true })
  email_verification_sent_at?: Date | null;

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
