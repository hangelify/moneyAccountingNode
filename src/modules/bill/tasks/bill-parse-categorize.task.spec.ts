import { BillParseCategorizeTask } from './bill-parse-categorize.task';

describe('BillParseCategorizeTask', () => {
  const task = new BillParseCategorizeTask();

  it('declares text + vision + json capabilities', () => {
    expect(task.requiredCapabilities.has('text')).toBe(true);
    expect(task.requiredCapabilities.has('vision')).toBe(true);
    expect(task.requiredCapabilities.has('json')).toBe(true);
  });

  it('names itself bill.parse-categorize', () => {
    expect(task.name).toBe('bill.parse-categorize');
  });

  it('renders subcategory tree and attaches image in the user message', async () => {
    const image = Buffer.from('img');
    const req = await task.buildRequest({
      image,
      mediaType: 'image/jpeg',
      subcategories: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          category_name: 'Bakery',
          sub_category_name: 'Bread',
        },
        {
          id: '22222222-2222-2222-2222-222222222222',
          category_name: 'Produce',
          sub_category_name: 'Tomatoes',
        },
      ],
    });

    const user = req.messages.find((m) => m.role === 'user');
    expect(user?.text).toContain(
      '11111111-1111-1111-1111-111111111111 | Bakery > Bread',
    );
    expect(user?.text).toContain(
      '22222222-2222-2222-2222-222222222222 | Produce > Tomatoes',
    );
    expect(user?.images).toHaveLength(1);
    expect(user?.images?.[0].data).toBe(image);
    expect(user?.images?.[0].mediaType).toBe('image/jpeg');
  });

  it('does not ask the model for the full OCR text', async () => {
    const req = await task.buildRequest({
      image: Buffer.from('img'),
      mediaType: 'image/jpeg',
      subcategories: [],
    });
    const system = req.messages.find((m) => m.role === 'system');
    expect(system?.text).not.toContain('raw_extracted_text');
  });
});
