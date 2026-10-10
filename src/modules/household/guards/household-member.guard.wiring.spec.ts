import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { createMikroOrmConfig } from '../../../mikro-orm.config';
import { AiGatewayModule } from '../../ai-gateway/ai-gateway.module';
import { BillModule } from '../../bill/bill.module';
import { BudgetModule } from '../../budget/budget.module';
import { CategoryModule } from '../../category/category.module';
import { HouseholdModule } from '../household.module';
import { MarketModule } from '../../market/market.module';
import { PlaningHorizonModule } from '../../planing-horizon/planing-horizon.module';
import { SubCategoryModule } from '../../sub-category/sub-category.module';
import { HouseholdMemberGuard } from './household-member.guard';

// Nest instantiates a @UseGuards() guard inside the controller's own module,
// so every module whose controllers use HouseholdMemberGuard must be able to
// resolve the guard's repositories itself, or the app fails to boot.
describe('HouseholdMemberGuard wiring', () => {
  // Required at construction time by HouseholdService and StorageModule.
  const env: Record<string, string> = {
    FRONTEND_URL: 'http://localhost:5173',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'test',
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
  };
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ['BillModule', BillModule],
    ['BudgetModule', BudgetModule],
    ['CategoryModule', CategoryModule],
    ['HouseholdModule', HouseholdModule],
    ['MarketModule', MarketModule],
    ['PlaningHorizonModule', PlaningHorizonModule],
    ['SubCategoryModule', SubCategoryModule],
  ])('%s can construct HouseholdMemberGuard', async (_name, feature) => {
    // compile() builds controller guards, so a missing repository fails here.
    const moduleRef = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({ ...createMikroOrmConfig(), connect: false }),
        // Global in AppModule; no AI providers are needed to build the graph.
        AiGatewayModule.forRoot({ providers: [] }),
        feature,
      ],
    }).compile();

    try {
      const guard = moduleRef.get(HouseholdMemberGuard, { strict: false });
      expect(guard).toBeInstanceOf(HouseholdMemberGuard);
    } finally {
      await moduleRef.close();
    }
  });
});
