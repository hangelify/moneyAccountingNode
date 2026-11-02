import { Migration } from '@mikro-orm/migrations';

export class Migration20261010120000_AddAiRequestsUserCreatedAtIndex extends Migration {
  override up(): void {
    // Daily AI budget check: SUM(total_cost_usd) per user over the last 24 h.
    this.addSql(
      `create index if not exists "ai_requests_user_id_created_at_index" on "ai_requests" ("user_id", "created_at");`,
    );
  }

  override down(): void {
    this.addSql(`drop index if exists "ai_requests_user_id_created_at_index";`);
  }
}
