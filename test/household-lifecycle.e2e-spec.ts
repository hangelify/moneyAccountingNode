import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import type { HouseholdResponseDto } from '../src/modules/household';
import type { CategoryBaseResponseDto } from '../src/modules/category';
import { CategoryDefaultsService } from '../src/modules/category/category-defaults.service';
import { DEFAULT_CATEGORY_TREE } from '../src/modules/category/defaults';

// HAN-22: creating and deleting households.
describe('Household lifecycle (e2e)', () => {
  let app: NestExpressApplication;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const auth = (user: TestUser): string => `Bearer ${user.accessToken}`;
  const sql = <T>(query: string, params: unknown[] = []): Promise<T> =>
    app.get(MikroORM).em.getConnection().execute(query, params) as Promise<T>;

  async function createHousehold(
    user: TestUser,
    body: object,
    status = 201,
  ): Promise<HouseholdResponseDto> {
    const res = await http()
      .post('/households')
      .set('Authorization', auth(user))
      .send(body)
      .expect(status);
    return res.body as HouseholdResponseDto;
  }

  async function listHouseholds(
    user: TestUser,
  ): Promise<HouseholdResponseDto[]> {
    const res = await http()
      .get('/households')
      .set('Authorization', auth(user))
      .expect(200);
    return res.body as HouseholdResponseDto[];
  }

  /** Invites `invitee` into `hid` (owned by `owner`) and accepts. */
  async function join(
    owner: TestUser,
    hid: string,
    invitee: TestUser,
  ): Promise<request.Response> {
    const res = await http()
      .post(`/households/${hid}/invites`)
      .set('Authorization', auth(owner))
      .send({ email: invitee.email })
      .expect(201);
    return http()
      .post('/households/invites/accept')
      .set('Authorization', auth(invitee))
      .send({ token: (res.body as { token: string }).token });
  }

  /** Brings the user (who has their personal household) to `total`. */
  async function fillUpTo(user: TestUser, total: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i < total; i++) {
      ids.push((await createHousehold(user, { name: `H${String(i)}` })).id);
    }
    return ids;
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(() => {
    resetThrottling(app);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('creation', () => {
    it('creates a household with the default categories', async () => {
      const user = await registerUser(app, 'create-seed');
      const created = await createHousehold(user, { name: 'Trip' });

      const res = await http()
        .get(`/households/${created.id}/categories`)
        .set('Authorization', auth(user))
        .expect(200);
      const names = (res.body as CategoryBaseResponseDto[])
        .map((c) => c.name)
        .sort();
      expect(names).toEqual(DEFAULT_CATEGORY_TREE.map((n) => n.name).sort());
    });

    it("uses the given currency, else the user's", async () => {
      const user = await registerUser(app, 'create-currency');
      expect(
        (await createHousehold(user, { name: 'Lei', currency: 'MDL' }))
          .currency,
      ).toBe('MDL');
      expect((await createHousehold(user, { name: 'Plain' })).currency).toBe(
        'EUR',
      );
    });

    it('rolls registration back when seeding fails', async () => {
      jest
        .spyOn(app.get(CategoryDefaultsService), 'seedForHousehold')
        .mockRejectedValueOnce(new Error('seed down'));
      const email = `seed-down-${String(Date.now())}@example.com`;

      await http()
        .post('/auth/register')
        .set('X-Client-Type', 'mobile')
        .send({ email, password: 'password123', first_name: 'Down' })
        .expect(500);

      const rows = await sql<{ n: number }[]>(
        'select count(*)::int as n from users where email = ?',
        [email],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('rolls household creation back when seeding fails', async () => {
      const user = await registerUser(app, 'create-seed-down');
      jest
        .spyOn(app.get(CategoryDefaultsService), 'seedForHousehold')
        .mockRejectedValueOnce(new Error('seed down'));

      await createHousehold(user, { name: 'Broken' }, 500);

      expect(await listHouseholds(user)).toHaveLength(1);
    });
  });

  describe('household limit', () => {
    it('rejects the sixth household', async () => {
      const user = await registerUser(app, 'limit-create');
      await fillUpTo(user, 5);

      const res = await http()
        .post('/households')
        .set('Authorization', auth(user))
        .send({ name: 'Sixth' })
        .expect(409);
      expect((res.body as { reason: string }).reason).toBe('household_limit');
      expect(await listHouseholds(user)).toHaveLength(5);
    });

    it('frees a slot when a household is deleted', async () => {
      const user = await registerUser(app, 'limit-free');
      const [first] = await fillUpTo(user, 5);

      await http()
        .delete(`/households/${String(first)}`)
        .set('Authorization', auth(user))
        .expect(204);
      await createHousehold(user, { name: 'Again' });
    });

    it('rejects accepting an invite at the household limit', async () => {
      const owner = await registerUser(app, 'limit-owner');
      const invitee = await registerUser(app, 'limit-invitee');
      await fillUpTo(invitee, 5);

      const res = await join(owner, owner.householdId, invitee);
      expect(res.status).toBe(409);
      expect((res.body as { reason: string }).reason).toBe('household_limit');
      expect(await listHouseholds(invitee)).toHaveLength(5);
    });

    it('answers already_member before the limit', async () => {
      const owner = await registerUser(app, 'limit-owner2');
      const invitee = await registerUser(app, 'limit-member');
      await fillUpTo(invitee, 4);
      expect((await join(owner, owner.householdId, invitee)).status).toBe(204);

      const res = await join(owner, owner.householdId, invitee);
      expect(res.status).toBe(409);
      expect((res.body as { reason: string }).reason).toBe('already_member');
    });
  });

  describe('deletion', () => {
    const del = (user: TestUser, hid: string): request.Test =>
      http().delete(`/households/${hid}`).set('Authorization', auth(user));

    it('rejects deleting the last household', async () => {
      const user = await registerUser(app, 'del-last');

      const res = await del(user, user.householdId).expect(409);
      expect((res.body as { reason: string }).reason).toBe('last_household');
      expect(await listHouseholds(user)).toHaveLength(1);
    });

    it('rejects deleting a household with other members', async () => {
      const owner = await registerUser(app, 'del-shared');
      const member = await registerUser(app, 'del-shared-member');
      await createHousehold(owner, { name: 'Spare' });
      expect((await join(owner, owner.householdId, member)).status).toBe(204);

      const res = await del(owner, owner.householdId).expect(409);
      expect((res.body as { reason: string }).reason).toBe(
        'household_has_members',
      );
    });

    it('forbids a member from deleting', async () => {
      const owner = await registerUser(app, 'del-owner');
      const member = await registerUser(app, 'del-member');
      expect((await join(owner, owner.householdId, member)).status).toBe(204);

      await del(member, owner.householdId).expect(403);
    });

    it('deletes a household', async () => {
      const user = await registerUser(app, 'del-ok');
      const spare = await createHousehold(user, { name: 'Spare' });

      await del(user, spare.id).expect(204);

      expect((await listHouseholds(user)).map((h) => h.id)).toEqual([
        user.householdId,
      ]);
      await http()
        .get(`/households/${spare.id}`)
        .set('Authorization', auth(user))
        .expect(403);
    });

    it("counts memberships in others' households", async () => {
      const a = await registerUser(app, 'del-count-a');
      const b = await registerUser(app, 'del-count-b');
      expect((await join(b, b.householdId, a)).status).toBe(204);

      await del(a, a.householdId).expect(204);
      expect((await listHouseholds(a)).map((h) => h.id)).toEqual([
        b.householdId,
      ]);
    });
  });
});
