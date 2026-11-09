// src/entities/bill.entity.ts
import { Collection, type Rel } from '@mikro-orm/core';
import {
  Entity,
  Property,
  BeforeCreate,
  BeforeUpdate,
  OneToMany,
  ManyToOne,
  Enum,
  Index,
  Check,
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { BillSubCategory } from './bill-sub-category.entity';
import { Household } from './household.entity';
import { User } from './user.entity';
import { Market } from './market.entity';
import { AiRequest } from './ai-request.entity';
import { Currency } from '../types/currency.enum';
import { BillStatus } from '../types/bill-status.enum';
import { BillParseErrorCode } from '../types/bill-parse-error.enum';
import { BillSource } from '../types/bill-source.enum';
import { HourMinuteType } from '../types/hour-minute.type';

export const BILLS_CLIENT_BATCH_UNIQUE = 'bills_household_client_batch_unique';

@Entity({ tableName: 'bills' })
// Dashboard and bill list: household + status, range on bill_date.
@Index({
  name: 'bills_household_status_date_index',
  expression:
    'create index "bills_household_status_date_index" on "bills" ("household_id", "status", "bill_date" desc) where "deleted_at" is null',
})
@Index({
  name: 'bills_market_id_index',
  expression:
    'create index "bills_market_id_index" on "bills" ("market_id") where "deleted_at" is null',
})
@Index({ name: 'bills_created_by_user_id_index', properties: ['created_by'] })
@Index({
  name: 'bills_confirmed_by_user_id_index',
  properties: ['confirmed_by'],
})
// Drafts list: a household's open drafts, newest first.
@Index({
  name: 'bills_household_drafts_created_index',
  expression:
    'create index "bills_household_drafts_created_index" on "bills" ("household_id", "created_at" desc, "id" desc) where "status" = \'draft\' and "deleted_at" is null',
})
// One open draft per receipt photo: a re-upload returns it instead of paying
// for another AI call.
@Index({
  name: 'bills_household_image_sha256_draft_unique',
  expression:
    'create unique index "bills_household_image_sha256_draft_unique" on "bills" ("household_id", "image_sha256") where "status" = \'draft\' and "deleted_at" is null and "image_sha256" is not null',
})
@Index({ name: 'bills_ai_request_id_index', properties: ['ai_request'] })
@Index({
  name: 'bills_duplicate_of_id_index',
  expression:
    'create index "bills_duplicate_of_id_index" on "bills" ("duplicate_of_id") where "duplicate_of_id" is not null',
})
// Receipt identity lookup; not unique, so "keep both" stays possible.
@Index({
  name: 'bills_household_fiscal_index',
  expression:
    'create index "bills_household_fiscal_index" on "bills" ("household_id", "fiscal_register_id", "fiscal_receipt_number") where "deleted_at" is null and "fiscal_receipt_number" is not null',
})
// One manual quick-entry submit (HAN-48): a replay finds its bills. Deleted
// bills keep their key, so a replay never brings them back.
@Index({
  name: BILLS_CLIENT_BATCH_UNIQUE,
  expression: `create unique index "${BILLS_CLIENT_BATCH_UNIQUE}" on "bills" ("household_id", "client_batch_id", "client_batch_index") where "client_batch_id" is not null`,
})
@Check({
  name: 'bills_client_batch_check',
  expression: '(client_batch_id is null) = (client_batch_index is null)',
})
@Check({
  name: 'bills_duplicate_of_check',
  expression: `(status::text = 'duplicate') = (duplicate_of_id is not null)`,
})
@Check({
  name: 'bills_parse_error_check',
  expression: `(status::text = 'failed') = (parse_error_code is not null)`,
})
export class Bill extends BaseEntity {
  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'decimal', precision: 19, scale: 2, nullable: false })
  amount!: number;

  /** `YYYY-MM-DD`; the `date` column has no time or timezone. */
  @Property({ type: 'date', runtimeType: 'string', nullable: false })
  bill_date!: string;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  created_at!: Date;

  @Property({ type: 'timestamptz', nullable: false, defaultRaw: 'NOW()' })
  updated_at!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  deleted_at?: Date;

  @Enum({
    items: () => BillStatus,
    type: 'enum',
    nativeEnumName: 'bill_status_enum',
    nullable: false,
    default: BillStatus.CONFIRMED,
  })
  status: BillStatus = BillStatus.CONFIRMED;

  /** Where the bill came from; the app's writers always name it. */
  @Enum({
    items: () => BillSource,
    type: 'enum',
    nativeEnumName: 'bill_source',
    nullable: false,
    default: BillSource.MANUAL,
  })
  source: BillSource = BillSource.MANUAL;

  @Property({ type: 'text', nullable: true })
  market_name_raw?: string;

  /** True when the model read no date and bill_date was set to the upload day. */
  @Property({ type: 'boolean', nullable: false, default: false })
  bill_date_inferred: boolean = false;

  /** sha256 (hex) of the stored receipt image; set on AI drafts only. */
  @Property({ type: 'varchar', length: 64, nullable: true })
  image_sha256?: string;

  @ManyToOne(() => AiRequest, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'ai_request_id',
  })
  ai_request?: Rel<AiRequest>;

  @ManyToOne(() => Household, { nullable: false })
  household!: Rel<Household>;

  @ManyToOne(() => User, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'created_by_user_id',
  })
  created_by?: Rel<User>;

  /** Who confirmed the AI draft; null on bills created by hand. */
  @ManyToOne(() => User, {
    nullable: true,
    deleteRule: 'set null',
    fieldName: 'confirmed_by_user_id',
  })
  confirmed_by?: Rel<User>;

  @Property({ type: 'timestamptz', nullable: true })
  confirmed_at?: Date;

  @ManyToOne(() => Market, { nullable: true })
  market?: Rel<Market>;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: true,
  })
  currency?: Currency;

  /** The confirmed bill this one copies; set exactly when status is duplicate. */
  @ManyToOne(() => Bill, {
    nullable: true,
    deleteRule: 'no action',
    fieldName: 'duplicate_of_id',
  })
  duplicate_of?: Rel<Bill> | null;

  /** Cash register / fiscal device id printed on the receipt. */
  @Property({ type: 'varchar', length: 64, nullable: true })
  fiscal_register_id?: string;

  @Property({ type: 'varchar', length: 64, nullable: true })
  fiscal_receipt_number?: string;

  /** `HH:MM` from the receipt timestamp. */
  @Property({ type: HourMinuteType, nullable: true })
  purchase_time?: string;

  /** Set exactly when status is failed. */
  @Enum({
    items: () => BillParseErrorCode,
    type: 'enum',
    nativeEnumName: 'bill_parse_error_enum',
    nullable: true,
  })
  parse_error_code?: BillParseErrorCode | null;

  /** Human-readable reason for a failed bill. */
  @Property({ type: 'text', nullable: true })
  parse_error_message?: string | null;

  /** The manual quick-entry submit this bill was saved from. */
  @Property({ type: 'uuid', nullable: true })
  client_batch_id?: string | null;

  /** The bill's row in that submit, from 0. */
  @Property({ type: 'smallint', nullable: true })
  client_batch_index?: number | null;

  /** S3 key of the receipt photo; set on every bill created from a batch. */
  @Property({ type: 'varchar', nullable: true })
  image_key?: string | null;

  @OneToMany(() => BillSubCategory, (bsc) => bsc.bill)
  billSubCategories = new Collection<BillSubCategory>(this);

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
