import { uuids } from './bill-move-checks';

describe('uuids', () => {
  const id = '3f2b8c1e-7a4d-4e5f-9b6a-1c2d3e4f5a6b';

  it('builds a uuid[] literal, nulls included', () => {
    expect(uuids([id, null])).toBe(`{${id},NULL}`);
  });

  it('refuses anything that is not a uuid', () => {
    expect(() => uuids([id, "1}'; drop table bills; --"])).toThrow(Error);
  });
});
