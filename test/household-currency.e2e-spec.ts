import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import type {
  HouseholdDetailResponseDto,
  HouseholdResponseDto,
  InviteResponseDto,
} from '../src/modules/household/dto/household-response.dto';

describe('Household currency (e2e)', () => {
  let app: NestExpressApplication;
  let owner: TestUser;

  const http = () => request(app.getHttpServer());
  const auth = (user: TestUser) => `Bearer ${user.accessToken}`;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    resetThrottling(app);
    owner = await registerUser(app, 'owner');
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives the personal household of a new user the EUR currency', async () => {
    const res = await http()
      .get('/households')
      .set('Authorization', auth(owner))
      .expect(200);
    const [household] = res.body as HouseholdResponseDto[];
    expect(household.currency).toBe('EUR');
  });

  it('lets the owner change the currency', async () => {
    const res = await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .send({ currency: 'USD' })
      .expect(200);
    expect((res.body as HouseholdResponseDto).currency).toBe('USD');

    const detail = await http()
      .get(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .expect(200);
    expect((detail.body as HouseholdDetailResponseDto).currency).toBe('USD');
  });

  it('rejects a currency change by a plain member', async () => {
    const jane = await registerUser(app, 'jane');
    const invite = await http()
      .post(`/households/${owner.householdId}/invites`)
      .set('Authorization', auth(owner))
      .send({ email: jane.email })
      .expect(201);
    await http()
      .post('/households/invites/accept')
      .set('Authorization', auth(jane))
      .send({ token: (invite.body as InviteResponseDto).token })
      .expect(204);

    await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(jane))
      .send({ currency: 'USD' })
      .expect(403);
  });

  it('rejects an update with nothing to change', async () => {
    await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .send({})
      .expect(400);
  });

  it('rejects an unknown currency', async () => {
    await http()
      .put(`/households/${owner.householdId}`)
      .set('Authorization', auth(owner))
      .send({ currency: 'XXX' })
      .expect(400);
  });
});
