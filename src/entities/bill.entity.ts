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
} from '@mikro-orm/decorators/legacy';
import { BaseEntity } from './base.entity';
import { BillSubCategory } from './bill-sub-category.entity';
import { Household } from './household.entity';
import { User } from './user.entity';
import { Market } from './market.entity';
import { AiRequest } from './ai-request.entity';
import { Currency } from '../types/currency.enum';
import { BillStatus } from '../types/bill-status.enum';

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
export class Bill extends BaseEntity {
  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ type: 'decimal', precision: 19, scale: 2, nullable: false })
  amount!: number;

  @Property({ type: 'date', nullable: false })
  bill_date!: Date;

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

  @ManyToOne(() => Market, { nullable: true })
  market?: Rel<Market>;

  @Enum({
    items: () => Currency,
    type: 'enum',
    nativeEnumName: 'currency_enum',
    nullable: true,
  })
  currency?: Currency;

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
