import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MikroORM } from '@mikro-orm/core';
import {
  createTestApp,
  registerUser,
  resetThrottling,
  TestUser,
} from './utils/app';
import type { HouseholdResponseDto } from '../src/modules/household';
import {
  CategoryDefaultsService,
  DEFAULT_CATEGORY_TREE,
  type CategoryBaseResponseDto,
} from '../src/modules/category';

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

  describe('own household name', () => {
    interface Named {
      name: string;
      original_name: string;
    }
    const setMine = (user: TestUser, hid: string, body: object): request.Test =>
      http()
        .put(`/households/${hid}/me`)
        .set('Authorization', auth(user))
        .send(body);
    async function seenBy(user: TestUser, hid: string): Promise<Named> {
      const res = await http()
        .get(`/households/${hid}`)
        .set('Authorization', auth(user))
        .expect(200);
      return res.body as Named;
    }

    async function shared(): Promise<{
      owner: TestUser;
      member: TestUser;
      hid: string;
    }> {
      const owner = await registerUser(app, 'name-owner');
      const member = await registerUser(app, 'name-member');
      expect((await join(owner, owner.householdId, member)).status).toBe(204);
      return { owner, member, hid: owner.householdId };
    }

    it('lets a member set their own name', async () => {
      const { owner, member, hid } = await shared();

      const res = await setMine(member, hid, {
        display_name: '  Дом  ',
      }).expect(200);
      expect((res.body as Named).name).toBe('Дом');
      expect((res.body as Named).original_name).toBe('Personal');

      expect((await seenBy(member, hid)).name).toBe('Дом');
      const listed = (await listHouseholds(member)).find((h) => h.id === hid);
      expect((listed as unknown as Named).name).toBe('Дом');
      expect(await seenBy(owner, hid)).toMatchObject({
        name: 'Personal',
        original_name: 'Personal',
      });
    });

    it('resets to the original name with null', async () => {
      const { member, hid } = await shared();
      await setMine(member, hid, { display_name: 'Дом' }).expect(200);

      const res = await setMine(member, hid, { display_name: null }).expect(
        200,
      );
      expect((res.body as Named).name).toBe('Personal');
    });

    it('rejects a blank name', async () => {
      const { member, hid } = await shared();
      await setMine(member, hid, { display_name: '   ' }).expect(400);
      await setMine(member, hid, {}).expect(400);
      await setMine(member, hid, { display_name: 'x'.repeat(256) }).expect(400);
    });

    it('follows the original rename unless overridden', async () => {
      const { owner, member, hid } = await shared();
      const other = await registerUser(app, 'name-other');
      expect((await join(owner, hid, other)).status).toBe(204);
      await setMine(other, hid, { display_name: 'Моё' }).expect(200);

      await http()
        .put(`/households/${hid}`)
        .set('Authorization', auth(owner))
        .send({ name: 'Семья 2' })
        .expect(200);

      expect((await seenBy(member, hid)).name).toBe('Семья 2');
      expect(await seenBy(other, hid)).toMatchObject({
        name: 'Моё',
        original_name: 'Семья 2',
      });
    });
  });

  describe('household list', () => {
    interface Listed {
      id: string;
      name: string;
      bill_count: number;
      member_count: number;
    }
    const list = async (user: TestUser): Promise<Listed[]> =>
      (await listHouseholds(user)) as unknown as Listed[];

    async function bill(
      hid: string,
      status: string,
      extra: { deleted?: boolean; duplicateOf?: string } = {},
    ): Promise<string> {
      const id = randomUUID();
      await sql(
        `insert into bills (id, household_id, bill_date, amount, status, duplicate_of_id, parse_error_code, deleted_at)
         values (?, ?, '2026-11-01', 10, ?, ?, ?, ?)`,
        [
          id,
          hid,
          status,
          extra.duplicateOf ?? null,
          status === 'failed' ? 'not_a_receipt' : null,
          extra.deleted ? new Date() : null,
        ],
      );
      return id;
    }

    it('counts confirmed and draft bills only', async () => {
      const user = await registerUser(app, 'list-bills');
      const empty = await createHousehold(user, { name: 'Empty' });
      const hid = user.householdId;
      const original = await bill(hid, 'confirmed');
      await bill(hid, 'draft');
      await bill(hid, 'failed');
      await bill(hid, 'duplicate', { duplicateOf: original });
      await bill(hid, 'confirmed', { deleted: true });

      const byId = new Map((await list(user)).map((h) => [h.id, h]));
      expect(byId.get(hid)?.bill_count).toBe(2);
      expect(byId.get(empty.id)?.bill_count).toBe(0);
    });

    it('counts members', async () => {
      const owner = await registerUser(app, 'list-members');
      const member = await registerUser(app, 'list-member');
      expect((await join(owner, owner.householdId, member)).status).toBe(204);

      const [mine] = await list(owner);
      expect(mine?.member_count).toBe(2);
    });

    it('orders households by creation', async () => {
      const user = await registerUser(app, 'list-order');
      await createHousehold(user, { name: 'A' });
      await createHousehold(user, { name: 'B' });

      expect((await list(user)).map((h) => h.name)).toEqual([
        'Personal',
        'A',
        'B',
      ]);
    });

    it('skips deleted households', async () => {
      const user = await registerUser(app, 'list-deleted');
      const gone = await createHousehold(user, { name: 'Gone' });
      await http()
        .delete(`/households/${gone.id}`)
        .set('Authorization', auth(user))
        .expect(204);

      expect((await list(user)).map((h) => h.id)).toEqual([user.householdId]);
    });
  });

  describe('review fixes', () => {
    it('lists created_at in the same format as the card', async () => {
      const user = await registerUser(app, 'fmt-created');
      const [listed] = await listHouseholds(user);
      const card = await http()
        .get(`/households/${user.householdId}`)
        .set('Authorization', auth(user))
        .expect(200);

      expect(listed?.created_at).toBe(
        (card.body as HouseholdResponseDto).created_at,
      );
    });

    const removeMember = (
      by: TestUser,
      hid: string,
      uid: string,
    ): request.Test =>
      http()
        .delete(`/households/${hid}/members/${uid}`)
        .set('Authorization', auth(by));

    async function userId(user: TestUser): Promise<string> {
      const rows = await sql<{ id: string }[]>(
        'select id from users where email = ?',
        [user.email],
      );
      return rows[0]?.id ?? '';
    }

    /** `member` belongs only to `owner`'s household afterwards. */
    async function onlyInShared(): Promise<{
      owner: TestUser;
      member: TestUser;
    }> {
      const owner = await registerUser(app, 'leave-owner');
      const member = await registerUser(app, 'leave-member');
      expect((await join(owner, owner.householdId, member)).status).toBe(204);
      await http()
        .delete(`/households/${member.householdId}`)
        .set('Authorization', auth(member))
        .expect(204);
      return { owner, member };
    }

    it('refuses a member leaving their last household', async () => {
      const { owner, member } = await onlyInShared();

      const res = await removeMember(
        member,
        owner.householdId,
        await userId(member),
      ).expect(409);
      expect((res.body as { reason: string }).reason).toBe('last_household');
      expect(await listHouseholds(member)).toHaveLength(1);
    });

    it('gives a removed member a personal household when it was their last', async () => {
      const { owner, member } = await onlyInShared();

      await removeMember(owner, owner.householdId, await userId(member)).expect(
        204,
      );

      const left = await listHouseholds(member);
      expect(left.map((h) => h.name)).toEqual(['Personal']);
      const cats = await http()
        .get(`/households/${String(left[0]?.id)}/categories`)
        .set('Authorization', auth(member))
        .expect(200);
      expect(cats.body as unknown[]).toHaveLength(DEFAULT_CATEGORY_TREE.length);
    });
  });
});
