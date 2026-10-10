import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import sharp from 'sharp';
import { createTestApp, registerUser } from './utils/app';
import { BillPhotoService } from '../src/modules/bill/bill-photo.service';
import { MAX_UPLOAD_BYTES } from '../src/modules/bill/receipt-image';

describe('parse-photo upload handling (e2e)', () => {
  let app: NestExpressApplication;
  let token: string;
  let hid: string;
  // Stands in for the AI call: the upload handling is under test.
  const parseAndCategorize = jest.fn();

  const upload = () =>
    request(app.getHttpServer())
      .post(`/households/${hid}/bills/parse-photo`)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp({
      override: (builder) =>
        builder
          .overrideProvider(BillPhotoService)
          .useValue({ parseAndCategorize }),
    });
    ({ accessToken: token, householdId: hid } = await registerUser(
      app,
      'upload',
    ));
  });

  beforeEach(() => {
    parseAndCategorize.mockReset().mockResolvedValue({
      parsed: {
        draft_id: '',
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: null,
        items: [],
      },
      requestId: '00000000-0000-4000-8000-000000000000',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a real JPEG sent as "image/jpg" and passes on a normalized JPEG', async () => {
    const jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();

    const res = await upload().attach('image', jpeg, {
      filename: 'bill.jpg',
      contentType: 'image/jpg',
    });

    expect(res.status).toBe(200);
    expect(parseAndCategorize).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/jpeg',
      hid,
      expect.any(String),
    );
  });

  it('answers 415 for a text file renamed to .jpg', async () => {
    const res = await upload().attach('image', Buffer.from('not an image'), {
      filename: 'bill.jpg',
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(415);
    expect(parseAndCategorize).not.toHaveBeenCalled();
  });

  it('answers 413 for a file over the upload limit, before the AI is called', async () => {
    const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0xff);

    const res = await upload().attach('image', tooBig, {
      filename: 'bill.jpg',
      contentType: 'image/jpeg',
    });

    expect(res.status).toBe(413);
    expect(parseAndCategorize).not.toHaveBeenCalled();
  });

  it('answers 400 for extra form fields', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();

    const res = await upload()
      .field('note', 'x')
      .attach('image', png, { filename: 'bill.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(parseAndCategorize).not.toHaveBeenCalled();
  });
});
